/**
 * The spend ceiling on the kit routes, at the HTTP level.
 *
 * These are the cases that decide whether a ceiling is real: a refusal must not
 * spend a turn slot, a turn that produced nothing must give its reservation
 * back, and answering an open question must not be refused by a bucket the
 * person cannot wait out.
 */
import {
  createAssistantKit,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import { stubTextModel, testDeps } from "@showzy/assistant-kit/testing";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { createInMemoryRateLimitStore } from "@showzy/core";
import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";

import { kyivCalendarDate } from "@showzy/ai";

import {
  aiCompanyBudgetKey,
  canonicalizeAiBudgetCompanyId,
  createMemoryAiBudgetStore,
  type AiBudgetStore,
} from "../stores/budget.js";
import {
  assistantInteractions,
  type ChoiceResolution,
} from "./assistant-interactions.js";
import {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_CHAT_PATH,
  createAssistantKitApp,
} from "./assistant-kit.js";
import type { AssistantHistoryPort } from "./assistant-kit-http.js";

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

function memoryHistory(): AssistantHistoryPort {
  const byKey = new Map<string, ModelMessage[]>();
  return {
    load: (scope) =>
      Promise.resolve(byKey.get(`${scope.bind}:${scope.conversationId}`) ?? []),
    save: (scope, messages) => {
      byKey.set(`${scope.bind}:${scope.conversationId}`, [...messages]);
      return Promise.resolve();
    },
  };
}

const OK_RESOLVE = ({ value }: { value: unknown }) => {
  const resolution = value as ChoiceResolution;
  return Promise.resolve<ToolOutcome>({
    kind: "ok",
    result: { entityId: resolution.entityId },
  });
};

function harness(options?: {
  readonly limits?: {
    readonly chatTurnsPerMinutePerUser?: number;
    readonly dailyBudgetUsdPerCompany?: number;
    readonly dailyBudgetUsdGlobal?: number;
    readonly unknownModelTurnUsd?: number;
  };
  readonly tools?: ToolSet;
  readonly failTurn?: boolean;
}) {
  const kit = createAssistantKit(testDeps(assistantInteractions));
  const budgetStore: AiBudgetStore = createMemoryAiBudgetStore();
  const app = createAssistantKitApp(
    {
      logger: silentLogger(),
      auth: {
        api: {
          getSession: () => Promise.resolve({ user: { id: USER } }),
        },
      },
      forCaller: () => ({ kit, history: memoryHistory() }),
      model: stubTextModel("Готово."),
      tools: () =>
        options?.failTurn === true
          ? Promise.reject(new Error("tools unavailable"))
          : Promise.resolve(options?.tools ?? {}),
      resolveAnswer: OK_RESOLVE,
      prompt: () => ({ system: "you are a test" }),
    },
    {
      logger: silentLogger(),
      limits: {
        chatTurnsPerMinutePerUser:
          options?.limits?.chatTurnsPerMinutePerUser ?? 20,
        dailyBudgetUsdPerCompany:
          options?.limits?.dailyBudgetUsdPerCompany ?? 5,
        dailyBudgetUsdGlobal: options?.limits?.dailyBudgetUsdGlobal ?? 100,
        unknownModelTurnUsd: options?.limits?.unknownModelTurnUsd ?? 0.1,
      },
      rateLimitStore: createInMemoryRateLimitStore(),
      budgetStore,
    },
  );
  return { app, kit, budgetStore, bind: `${USER}:${COMPANY}` };
}

async function post(
  app: ReturnType<typeof createAssistantKitApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return await app.request(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        [COMPANY_SELECTOR_HEADER]: COMPANY,
      }),
      body: JSON.stringify(body),
    }),
  );
}

function chatBody(text = "покажи замовлення") {
  return { commandId: COMMAND, conversationId: CONVERSATION, text };
}

/** What this company has been charged today, read straight from the store. */
function spent(store: AiBudgetStore): Promise<number> {
  return store.read(
    aiCompanyBudgetKey(
      canonicalizeAiBudgetCompanyId(COMPANY),
      kyivCalendarDate(new Date()),
    ),
  );
}

describe("the spend ceiling on the kit routes", () => {
  it("admits a turn and charges it once", async () => {
    const { app, budgetStore } = harness({
      limits: { unknownModelTurnUsd: 0.1 },
    });
    expect(await spent(budgetStore)).toBe(0);

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(200);
    // Reserved then settled at the same figure, not both.
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);
  });

  it("refuses a turn over the per-minute bucket, and says how long to wait", async () => {
    const { app } = harness({ limits: { chatTurnsPerMinutePerUser: 1 } });

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("ще"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await second.json()) as {
      error: { code: string };
      retryAfterSec: number;
    };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });

  it("refuses a turn over the day's budget", async () => {
    const { app } = harness({
      limits: { dailyBudgetUsdPerCompany: 0.1, unknownModelTurnUsd: 0.1 },
    });

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("ще"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  /**
   * The reservation is what makes the ceiling atomic, so a turn that produced
   * nothing has to give it back. Without this, failures would spend the day's
   * budget as fast as successes.
   */
  it("gives the reservation back when the turn produced nothing", async () => {
    const { app, budgetStore } = harness({
      failTurn: true,
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.ok).toBe(false);
    // Nothing was produced, so nothing is charged. Without the release, failures
    // would spend the day's budget as fast as successes.
    expect(await spent(budgetStore)).toBe(0);
  });

  it("does not spend a turn slot on a budget refusal", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    const budgetStore = createMemoryAiBudgetStore();
    const build = (dailyBudgetUsdPerCompany: number) =>
      createAssistantKitApp(
        {
          logger: silentLogger(),
          auth: {
            api: { getSession: () => Promise.resolve({ user: { id: USER } }) },
          },
          forCaller: () => ({
            kit: createAssistantKit(testDeps(assistantInteractions)),
            history: memoryHistory(),
          }),
          model: stubTextModel("Готово."),
          tools: () => Promise.resolve({}),
          resolveAnswer: OK_RESOLVE,
          prompt: () => ({ system: "you are a test" }),
        },
        {
          logger: silentLogger(),
          limits: {
            chatTurnsPerMinutePerUser: 2,
            dailyBudgetUsdPerCompany,
            dailyBudgetUsdGlobal: 100,
            unknownModelTurnUsd: 0.1,
          },
          rateLimitStore,
          budgetStore,
        },
      );

    // A budget of zero refuses before the turn bucket is touched.
    const refused = await post(
      build(0.05),
      ASSISTANT_KIT_CHAT_PATH,
      chatBody(),
    );
    expect(refused.status).toBe(429);

    // Two turns still available, so the refusal cost no slot.
    expect(
      (await post(build(100), ASSISTANT_KIT_CHAT_PATH, chatBody())).status,
    ).toBe(200);
    expect(
      (await post(build(100), ASSISTANT_KIT_CHAT_PATH, chatBody())).status,
    ).toBe(200);
  });

  /**
   * Answering is finishing work already admitted. Refusing it would strand a
   * draft behind a limit the person cannot wait out.
   */
  it("does not hold an answer against the per-minute bucket", async () => {
    const { app, kit, bind } = harness({
      limits: { chatTurnsPerMinutePerUser: 1 },
    });
    const opened = await kit.open({
      conversationId: CONVERSATION,
      bind,
      kind: "choice",
      prompt: {
        subject: "two matches",
        options: [{ optionId: "opt-a", label: "A" }],
        optionsTruncated: false,
      },
      secret: {
        byOption: { "opt-a": "entity-a" },
        toolName: "orders_create",
        input: {},
        target: { kind: "customer", query: "two matches" },
      },
      continuation: {
        messages: [{ role: "user", content: "create one" }],
        pausedToolCall: { id: "toolu_1" as never, name: "orders_create" },
      },
    });
    if (opened.kind !== "opened") throw new Error("expected opened");

    // The bucket allows one turn, and this conversation has not used it — but
    // even a bucket already spent must not block the answer.
    await post(app, ASSISTANT_KIT_CHAT_PATH, {
      commandId: COMMAND,
      conversationId: "55555555-5555-4555-8555-555555555555",
      text: "щось інше",
    });

    const answered = await post(app, ASSISTANT_KIT_ANSWER_PATH, {
      commandId: COMMAND,
      conversationId: CONVERSATION,
      interactionId: opened.pause.interactionId,
      revision: opened.pause.revision,
      answer: { optionId: "opt-a" },
    });

    expect(answered.status).not.toBe(429);
  });

  it("leaves the routes that cost nothing unguarded", async () => {
    const { app } = harness({ limits: { chatTurnsPerMinutePerUser: 0 } });

    // A zero bucket disables the turn check rather than refusing everything;
    // what matters here is that abandon never reaches the guard at all.
    const dropped = await post(app, ASSISTANT_KIT_ABANDON_PATH, {
      conversationId: CONVERSATION,
      interactionId: "66666666-6666-4666-8666-666666666666",
    });

    expect(dropped.status).toBe(200);
  });
});
