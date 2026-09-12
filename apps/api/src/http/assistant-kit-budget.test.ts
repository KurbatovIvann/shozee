/**
 * The spend ceiling on the kit routes, at the HTTP level.
 *
 * These are the cases that decide whether a ceiling is real: a refusal must not
 * spend a turn slot, a request that stored no turn must give its reservation
 * back, and answering an open question must not be refused by a bucket the
 * person cannot wait out.
 *
 * Since the switch (SHO-563) there is nothing to settle after the fact. A turn
 * runs in the worker, so the reservation the accept took **is** the charge and
 * travels onto the turn row; the worker gives it back if the turn never reached
 * the model. What this suite pins at the HTTP edge is the other half: every
 * request that did *not* store a turn gives its reservation back here.
 */
import { randomUUID } from "node:crypto";

import {
  createAssistantKit,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import { stubTextModel, testDeps } from "@showzy/assistant-kit/testing";
import {
  acceptProvedRollback,
  aiCompanyBudgetKey,
  assistantInteractions,
  canonicalizeAiBudgetCompanyId,
  createMemoryAiBudgetStore,
  memoryAssistantKitCommands,
  memoryAssistantTurnStore,
  type AiBudgetStore,
  type AssistantHistoryPort,
  type AssistantTurnStore,
  type ChoiceResolution,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { createInMemoryRateLimitStore } from "@showzy/core";
import { ConflictError, CoreInvariantError } from "@showzy/core/errors";
import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";

import { kyivCalendarDate } from "@showzy/ai";

import {
  ASSISTANT_KIT_ABANDON_PATH,
  ASSISTANT_KIT_ANSWER_PATH,
  ASSISTANT_KIT_CHAT_PATH,
  createAssistantKitApp,
} from "./assistant-kit.js";

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

/**
 * An accept that fails the way a database incident fails one.
 *
 * It gives the reservation back on a failure that proves the accept rolled
 * back, because that is the store's contract and not the route's: the real
 * store does it in its own `finally`, and since SHO-572 the accept path is the
 * only place that decision is made. The predicate is imported rather than
 * restated, so this double cannot drift from the store it stands in for.
 */
function brokenTurns(failure: () => Error): AssistantTurnStore {
  return {
    accept: async (input) => {
      const error = failure();
      if (acceptProvedRollback(error)) {
        await input.releaseUnusedHold();
      }
      throw error;
    },
    start: () => Promise.reject(failure()),
    finish: () => Promise.reject(failure()),
    activeTurn: () => Promise.resolve(null),
  };
}

/**
 * One incident, then recovery: the first accept fails unprovably and every
 * later one is the real store. What a person's retry actually meets.
 */
function failsFirstAccept(
  real: AssistantTurnStore,
  failure: () => Error,
): AssistantTurnStore {
  let attempts = 0;
  return {
    ...real,
    accept: (input) => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(failure()) : real.accept(input);
    },
  };
}

function harness(options?: {
  readonly limits?: {
    readonly chatTurnsPerMinutePerUser?: number;
    readonly dailyBudgetUsdPerCompany?: number;
    readonly dailyBudgetUsdGlobal?: number;
    readonly unknownModelTurnUsd?: number;
  };
  readonly tools?: ToolSet;
  /**
   * The accept fails. `proven` is a core refusal, which cannot have committed,
   * so no turn row holds the reservation; `unproven` is an `INTERNAL`, which
   * may have committed after all.
   */
  readonly failAccept?: "proven" | "unproven" | "first-unproven";
  /**
   * The handler throws on its way to the accept — the shape of a `kit.peek`,
   * `kit.claim`, `runtime.tools` or `kit.open` failure. No turn row can ever
   * own that request's reservation.
   */
  readonly failBeforeAccept?: boolean;
}) {
  const kit = createAssistantKit(testDeps(assistantInteractions));
  const failAccept = options?.failAccept;
  const unproven = () =>
    new CoreInvariantError("the accept was not acknowledged");
  const realTurns = memoryAssistantTurnStore(kit.messages);
  const turns =
    failAccept === undefined
      ? realTurns
      : failAccept === "first-unproven"
        ? failsFirstAccept(realTurns, unproven)
        : brokenTurns(() =>
            failAccept === "proven"
              ? new ConflictError("the accept was rolled back")
              : unproven(),
          );
  const scopedKit =
    options?.failBeforeAccept === true
      ? {
          ...kit,
          peek: () =>
            Promise.reject(new Error("the conversation could not be read")),
        }
      : kit;
  const history = memoryHistory();
  const budgetStore: AiBudgetStore = createMemoryAiBudgetStore();
  const app = createAssistantKitApp(
    {
      logger: silentLogger(),
      commands: memoryAssistantKitCommands(),
      auth: {
        api: {
          getSession: () =>
            Promise.resolve({
              user: { id: USER },
              session: { id: "session-1" },
            }),
        },
      },
      forCaller: () => ({ kit: scopedKit, history, turns }),
      staffCompany: () => Promise.resolve(COMPANY),
      model: stubTextModel("Готово."),
      tools: () => Promise.resolve(options?.tools ?? {}),
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

/**
 * A fresh `commandId` per call unless one is given.
 *
 * Two sends with the same token are one command, and the server replays the
 * second without accepting it — correct, and not what these tests are
 * measuring. A budget test that accidentally sent a retry would read as a
 * ceiling holding when nothing had been charged.
 */
function chatBody(text = "покажи замовлення", commandId = randomUUID()) {
  return { commandId, conversationId: CONVERSATION, text };
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
  /**
   * The reservation is the charge now: the accept takes it onto the turn row,
   * and nothing here settles it a second time.
   */
  it("admits a turn and charges it once", async () => {
    const { app, budgetStore } = harness({
      limits: { unknownModelTurnUsd: 0.1 },
    });
    expect(await spent(budgetStore)).toBe(0);

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(202);
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);
  });

  it("refuses a turn over the per-minute bucket, and says how long to wait", async () => {
    const { app } = harness({ limits: { chatTurnsPerMinutePerUser: 1 } });

    const first = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());
    const second = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody("ще"));

    expect(first.status).toBe(202);
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

    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
  });

  /**
   * The reservation is what makes the ceiling atomic, so a request that stored
   * no turn has to give it back. Without this, a database incident would spend
   * the day's budget as fast as successful turns do.
   */
  it("gives the reservation back when the failure proves no turn was stored", async () => {
    const { app, budgetStore } = harness({
      failAccept: "proven",
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.ok).toBe(false);
    expect(await spent(budgetStore)).toBe(0);
  });

  /**
   * The other direction, and the one that must fail closed. An `INTERNAL` may
   * have been raised after COMMIT, in which case the stored turn holds this
   * reservation and the worker will release it. Giving it back here would put
   * the counter below real spend and lift the day's cap — and the turn's own
   * release would then give it back a second time.
   */
  it("keeps the reservation when the failure does not prove nothing was stored", async () => {
    const { app, budgetStore } = harness({
      failAccept: "unproven",
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.ok).toBe(false);
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);
  });

  it("does not spend a turn slot on a budget refusal", async () => {
    const rateLimitStore = createInMemoryRateLimitStore();
    const budgetStore = createMemoryAiBudgetStore();
    const build = (dailyBudgetUsdPerCompany: number) => {
      const kit = createAssistantKit(testDeps(assistantInteractions));
      return createAssistantKitApp(
        {
          logger: silentLogger(),
          commands: memoryAssistantKitCommands(),
          auth: {
            api: {
              getSession: () =>
                Promise.resolve({
                  user: { id: USER },
                  session: { id: "session-1" },
                }),
            },
          },
          forCaller: () => ({
            kit,
            history: memoryHistory(),
            turns: memoryAssistantTurnStore(kit.messages),
          }),
          staffCompany: () => Promise.resolve(COMPANY),
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
    };

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
    ).toBe(202);
    expect(
      (await post(build(100), ASSISTANT_KIT_CHAT_PATH, chatBody())).status,
    ).toBe(202);
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

/**
 * A replay accepted no turn and stored nothing, so it is not charged (SHO-547).
 *
 * The per-minute bucket still counts it, and that is deliberate rather than
 * overlooked: the bucket is admission control on how often a person may ask,
 * it runs before the handler can know a command has already been seen, and a
 * retry is an ask. Money is the quantity that must not double, and it does not.
 */
/**
 * One turn, one reservation, however many times the phone asks for it
 * (SHO-572).
 *
 * Since the switch the routes accept and return, so a person whose accept
 * failed retries under the same command — and `/kit/chat` gives its command
 * back on any failed accept, which makes the retry the expected path rather
 * than a rare one. An `INTERNAL` may have committed, so the reservation is
 * deliberately kept; before this slice each retry then took another, and a
 * database incident would spend a company's whole Kyiv day in a few taps.
 *
 * The reservation is keyed by the turn — kind, conversation and command, the
 * same identity `assistant_turns` is keyed by — so every retry finds the first
 * attempt's reservation instead of taking one.
 */
describe("a retry of a command whose accept failed", () => {
  it("leaves one reservation behind however many times it is retried", async () => {
    const { app, budgetStore } = harness({
      failAccept: "unproven",
      limits: { unknownModelTurnUsd: 0.1 },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post(
        app,
        ASSISTANT_KIT_CHAT_PATH,
        chatBody("створи", COMMAND),
      );
      expect(response.ok).toBe(false);
    }

    // Kept, not released — an `INTERNAL` may have committed — but kept *once*.
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);
  });

  it("reserves nothing when the accept finally succeeds, and is answered with the conversation as it stands", async () => {
    const { app, budgetStore } = harness({
      failAccept: "first-unproven",
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const failed = await post(
      app,
      ASSISTANT_KIT_CHAT_PATH,
      chatBody("створи замовлення", COMMAND),
    );
    expect(failed.ok).toBe(false);
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);

    const retry = await post(
      app,
      ASSISTANT_KIT_CHAT_PATH,
      chatBody("створи замовлення", COMMAND),
    );

    // The turn is accepted and the window holds the person's message, so the
    // retry is not a tap that does nothing.
    expect(retry.status).toBe(202);
    const body = (await retry.json()) as {
      status: string;
      window: { messages: { role: string }[] };
    };
    expect(body.status).toBe("accepted");
    expect(body.window.messages.some((each) => each.role === "user")).toBe(
      true,
    );
    // The accepted turn holds the reservation the first attempt took. The
    // retry took none of its own, so the day is charged once for one turn.
    expect(await spent(budgetStore)).toBeCloseTo(0.1, 5);
  });

  /**
   * The other half of "who owns the hold": a reservation that never reached an
   * accept can belong to nothing, because the accept is the only thing that can
   * put one on a turn row. It goes back rather than standing until Kyiv
   * midnight.
   */
  it("gives the reservation back when the handler fails before any accept", async () => {
    const { app, budgetStore } = harness({
      failBeforeAccept: true,
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const response = await post(app, ASSISTANT_KIT_CHAT_PATH, chatBody());

    expect(response.status).toBe(500);
    expect(await spent(budgetStore)).toBe(0);
  });
});

describe("a replayed command", () => {
  it("is not charged a second time", async () => {
    const { app, budgetStore } = harness({
      limits: { unknownModelTurnUsd: 0.1 },
    });

    const first = await post(
      app,
      ASSISTANT_KIT_CHAT_PATH,
      chatBody("створи", COMMAND),
    );
    const retry = await post(
      app,
      ASSISTANT_KIT_CHAT_PATH,
      chatBody("створи", COMMAND),
    );

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(await spent(budgetStore)).toBe(0.1);
  });
});
