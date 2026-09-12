/**
 * The worker's processor against a real database, real actions and a real pause
 * store (SHO-569, ADR-0039). It lives here because running a turn needs the
 * action registry, which only this composition root builds.
 *
 * Every turn is accepted the way the API accepts it (the T2 store), and its
 * history is seeded directly: the T5 routes save a turn's history before they
 * accept it, and the worker runs chat and answer turns alike from history. The
 * model is a stub. Nothing waits on a clock: the turn's deadline is fired by the
 * test, at the point the test chooses.
 */
import { randomUUID } from "node:crypto";

import type {
  ChatPart,
  LanguageModel,
  ModelMessage,
  ToolOutcome,
  ToolSet,
} from "@showzy/assistant-kit";
import {
  stubModel,
  stubModelFailingAfter,
  stubTextStep,
  stubToolCallStep,
} from "@showzy/assistant-kit/testing";
import {
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  createAssistantRuntime,
  createAssistantTurnProcessor,
  createMemoryAiBudgetStore,
  createPostgresAssistantTurnStore,
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  enforceStaffAssistantBudget,
  type AiBudgetStore,
  type AssistantRuntime,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
  type StaffAssistantBudgetHold,
} from "@showzy/assistant-runtime";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
} from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantChatMessages,
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { and, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createActionRegistry } from "./registry.js";

const COMPANY = kitIdentities.companies.a;
const ANNA = kitIdentities.users.anna;
const KYIV_DATE = "2026-09-11";
const HOLD: StaffAssistantBudgetHold = {
  companyReservedUsd: 0.1,
  globalReservedUsd: 0.1,
  kyivDate: KYIV_DATE,
};
/** Noon in Kyiv on `KYIV_DATE`: when a real reservation below is dated. */
const RESERVED_AT = new Date("2026-09-11T09:00:00.000Z");
/** What the day's counters hold before a turn: this turn's hold and others'. */
const COUNTER_BEFORE = 0.35;
const LIST_TOOL = "customers_list_customers";
const CREATE_TOOL = "customers_createCustomer";
const DELETE_TOOL = "customers_deleteCustomer";

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;
let pipeline: ActionPipelineDeps;
const registry = createActionRegistry();

/** The address every action of a test was invoked with, by action name. */
const invocations: { action: string; clientIp: string | undefined }[] = [];

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
  const base = kit.pipeline;
  pipeline = {
    ...base,
    hooks: {
      ...base.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
      rateLimit: {
        enforce: async (env) => {
          invocations.push({
            action: env.contract.name,
            clientIp: env.request.clientIp,
          });
          await base.hooks?.rateLimit?.enforce(env);
        },
      },
    },
  };
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

beforeEach(async () => {
  await redis.flushall();
  invocations.length = 0;
});

function runtimeWith(model: LanguageModel): AssistantRuntime {
  return createAssistantRuntime({ registry, pipeline, model, redis });
}

/** For seeding and reading back; its model is never called. */
function seedingRuntime(): AssistantRuntime {
  return runtimeWith("mock");
}

function callerOf(userId: string) {
  return {
    userId,
    companySelector: COMPANY,
    requestId: randomUUID(),
    clientIp: "127.0.0.1",
  };
}

function bindOf(userId: string): string {
  return `${userId}:${COMPANY}`;
}

async function newConversation(userId: string): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id, companyId: COMPANY, userId });
  return id;
}

interface Accepted {
  readonly job: AssistantTurnJob;
  readonly conversationId: string;
  readonly commandId: string;
  readonly placeholderId: string;
  readonly userId: string;
}

async function accepted(options: {
  readonly history: readonly ModelMessage[];
  readonly userId?: string;
  readonly conversationId?: string;
  readonly continuesCommandId?: string;
  readonly answerEarned?: readonly ChatPart[];
  /**
   * Reserve against this store the way the route does, instead of handing the
   * accept a bare `HOLD`.
   *
   * Since SHO-572 a reservation is a record under the turn's identity *and* the
   * counters, and only a release that finds the record subtracts. A turn row
   * carrying a hold no reservation ever made is a state no route can produce,
   * so a test asserting about the day's counters has to make a real one.
   */
  readonly budget?: AiBudgetStore;
}): Promise<Accepted> {
  const userId = options.userId ?? ANNA;
  const caller = callerOf(userId);
  const conversationId =
    options.conversationId ?? (await newConversation(userId));
  const bind = bindOf(userId);
  await seedingRuntime()
    .forCaller(caller)
    .history.save({ conversationId, bind }, options.history);
  const commandId = randomUUID();
  const budgetHold =
    options.budget === undefined
      ? HOLD
      : (
          await enforceStaffAssistantBudget({
            logger: pipeline.logger,
            requestId: randomUUID(),
            userId,
            companyId: COMPANY,
            turn: {
              kind: options.answerEarned === undefined ? "chat" : "answer",
              conversationId,
              commandId,
            },
            skipTurnLimit: true,
            now: RESERVED_AT,
            budgetStore: options.budget,
            limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
          })
        ).hold;
  const common = {
    conversationId,
    commandId,
    bind,
    sessionId: `session-${userId}`,
    budgetHold,
    releaseUnusedHold: () => Promise.resolve(),
    ...(options.continuesCommandId === undefined
      ? {}
      : { continuesCommandId: options.continuesCommandId }),
  };
  const result = await createPostgresAssistantTurnStore(
    { pipeline },
    caller,
  ).accept(
    options.answerEarned === undefined
      ? { ...common, kind: "chat", text: "покажи клієнтів" }
      : { ...common, kind: "answer", earned: options.answerEarned },
  );
  if (result.outcome !== "accepted") {
    throw new Error(`expected an accepted turn, got ${result.outcome}`);
  }
  return {
    job: result.job,
    conversationId,
    commandId,
    placeholderId: result.turn.placeholderMessageId,
    userId,
  };
}

interface Published {
  readonly event: AssistantPublishedEvent;
  /** The message's revision in Postgres when the event was published. */
  readonly storedRevision: number | undefined;
  /** The turn row's status when the event was published. */
  readonly turnStatus: string | undefined;
}

async function seededBudget(before = COUNTER_BEFORE): Promise<AiBudgetStore> {
  const store = createMemoryAiBudgetStore();
  await store.add(aiCompanyBudgetKey(COMPANY, KYIV_DATE), before, 3600);
  await store.add(aiGlobalBudgetKey(KYIV_DATE), before, 3600);
  return store;
}

async function counters(store: AiBudgetStore) {
  return {
    company: await store.read(aiCompanyBudgetKey(COMPANY, KYIV_DATE)),
    global: await store.read(aiGlobalBudgetKey(KYIV_DATE)),
  };
}

interface Harness {
  readonly process: (job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome>;
  readonly published: Published[];
  readonly budget: AiBudgetStore;
  /** The turn's deadline, fired now. */
  fireDeadline(): void;
}

async function harness(
  runtime: AssistantRuntime,
  /** The store the turn was reserved against, when the test made a real one. */
  provided?: AiBudgetStore,
): Promise<Harness> {
  const budget = provided ?? (await seededBudget());
  const published: Published[] = [];
  let fire: (() => void) | undefined;
  const process = createAssistantTurnProcessor({
    runtime,
    pipeline,
    budgetStore: budget,
    deadline: (abort) => {
      fire = abort;
      return () => {
        fire = undefined;
      };
    },
    publisher: {
      async publish(_address, event) {
        const storedRevision =
          event.type === "message.updated"
            ? (
                await kit.db.runtime.db
                  .select({ revision: assistantChatMessages.revision })
                  .from(assistantChatMessages)
                  .where(
                    eq(
                      assistantChatMessages.messageId,
                      event.message.messageId,
                    ),
                  )
              )[0]?.revision
            : undefined;
        const turnStatus =
          event.type === "message.updated"
            ? undefined
            : (
                await kit.db.runtime.db
                  .select({ status: assistantTurns.status })
                  .from(assistantTurns)
                  .where(eq(assistantTurns.commandId, event.commandId))
              )[0]?.status;
        published.push({ event, storedRevision, turnStatus });
      },
    },
  });
  return {
    process,
    published,
    budget,
    fireDeadline: () => {
      if (fire === undefined) {
        throw new Error("no deadline is armed");
      }
      fire();
    },
  };
}

async function placeholder(messageId: string) {
  const row = (
    await kit.db.runtime.db
      .select({
        message: assistantChatMessages.message,
        revision: assistantChatMessages.revision,
      })
      .from(assistantChatMessages)
      .where(eq(assistantChatMessages.messageId, messageId))
  )[0];
  if (row === undefined) {
    throw new Error("placeholder is missing");
  }
  const { parts } = row.message as { readonly parts: readonly ChatPart[] };
  return { parts, revision: row.revision };
}

function kinds(parts: readonly ChatPart[]): string[] {
  return parts.map((part) => part.kind);
}

function texts(parts: readonly ChatPart[]) {
  return parts.flatMap((part) =>
    part.kind === "text" ? [{ text: part.text, status: part.status }] : [],
  );
}

async function turnRow(commandId: string) {
  const row = (
    await kit.db.runtime.db
      .select({
        status: assistantTurns.status,
        companyReservedMicroUsd: assistantTurns.companyReservedMicroUsd,
      })
      .from(assistantTurns)
      .where(eq(assistantTurns.commandId, commandId))
  )[0];
  if (row === undefined) {
    throw new Error("turn row is missing");
  }
  return row;
}

async function historyOf(turn: Accepted): Promise<string> {
  const messages = await seedingRuntime()
    .forCaller(callerOf(turn.userId))
    .history.load({
      conversationId: turn.conversationId,
      bind: bindOf(turn.userId),
    });
  return JSON.stringify(messages);
}

/** Runs `after` once the named tool has returned, inside the turn. */
function afterTool(
  runtime: AssistantRuntime,
  toolName: string,
  after: () => void | Promise<void>,
): AssistantRuntime {
  return {
    ...runtime,
    tools: async (context) => {
      const set = await runtime.tools(context);
      const definition = set[toolName];
      const execute = definition?.execute;
      if (definition === undefined || execute === undefined) {
        throw new Error(`${toolName} is not offered`);
      }
      const wrapped: ToolSet = { ...set };
      wrapped[toolName] = {
        ...definition,
        execute: async (input, options) => {
          const outcome = (await execute(input, options)) as ToolOutcome;
          await after();
          return outcome;
        },
      };
      return wrapped;
    },
  };
}

/** A model that counts every call and fails each one. */
function modelThatMustNotRun() {
  const calls = { count: 0 };
  return {
    calls,
    model: stubModelFailingAfter([], {
      before: () => {
        calls.count += 1;
      },
    }),
  };
}

const USER_ASKS: ModelMessage[] = [
  { role: "user", content: "покажи клієнтів" },
];

describe("a turn the worker runs", () => {
  it("stores its card and reply, finishes done, keeps the hold as the charge, and publishes each event after its write", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const h = await harness(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_list", LIST_TOOL, {}),
          stubTextStep("Ось клієнти."),
        ]),
      ),
    );

    const outcome = await h.process(turn.job);

    expect(outcome).toEqual({
      kind: "finished",
      status: "done",
      reachedModel: true,
    });
    const stored = await placeholder(turn.placeholderId);
    expect(kinds(stored.parts)).toEqual(["card", "text"]);
    expect(texts(stored.parts)).toEqual([
      { text: "Ось клієнти.", status: "complete" },
    ]);
    expect((await turnRow(turn.commandId)).status).toBe("done");
    // The reservation stands as the charge: nothing was given back.
    expect(await counters(h.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
    expect(await historyOf(turn)).toContain("toolu_list");

    expect(h.published.map((entry) => entry.event.type)).toEqual([
      "turn.started",
      "message.updated",
      "message.updated",
      "turn.finished",
    ]);
    const [started, card, reply, finished] = h.published;
    expect(started?.turnStatus).toBe("running");
    for (const update of [card, reply]) {
      // Built from the stored message after the write: its revision is stored.
      expect(update?.event.type === "message.updated").toBe(true);
      if (update?.event.type === "message.updated") {
        expect(update.event.message.revision).toBe(update.storedRevision);
      }
    }
    expect(
      card?.event.type === "message.updated" ? card.event.message.revision : 0,
    ).toBeLessThan(
      reply?.event.type === "message.updated"
        ? reply.event.message.revision
        : 0,
    );
    expect(finished?.turnStatus).toBe("done");
    expect(finished?.event).toMatchObject({
      type: "turn.finished",
      status: "done",
      commandId: turn.commandId,
    });
    if (finished?.event.type === "turn.finished") {
      // The worker read the window as the turn's author, so it travels with the
      // finish; only the reconciler publishes a status without one (SHO-570).
      expect(finished.event.window?.messages.at(-1)?.revision).toBe(
        stored.revision,
      );
    }

    // No request, so no address on the actions its tools ran.
    const listed = invocations.filter(
      (entry) => entry.action === "customers.listCustomers",
    );
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((entry) => entry.clientIp)).toEqual(
      listed.map(() => undefined),
    );
  });

  it("opens the question a tool asked, keeps its continuation as history, and finishes done", async () => {
    const customerId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: customerId,
      companyId: COMPANY,
      name: "Катя Архівна",
      email: `archived-${customerId}@example.com`,
      status: "archived",
    });
    const turn = await accepted({ history: USER_ASKS });
    const h = await harness(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_delete", DELETE_TOOL, { id: customerId }),
        ]),
      ),
    );

    const outcome = await h.process(turn.job);

    expect(outcome).toMatchObject({ kind: "finished", status: "done" });
    const stored = await placeholder(turn.placeholderId);
    expect(kinds(stored.parts)).toEqual(["interaction", "text"]);
    expect(texts(stored.parts)).toEqual([{ text: "", status: "complete" }]);
    const window = await seedingRuntime()
      .forCaller(callerOf(ANNA))
      .kit.messages.read({
        conversationId: turn.conversationId,
        bind: bindOf(ANNA),
      });
    expect(window.openPause?.kind).toBe("confirmation");
    expect(await historyOf(turn)).toContain("toolu_delete");
    const exists = await kit.db.runtime.db
      .select({ id: companyCustomers.id })
      .from(companyCustomers)
      .where(eq(companyCustomers.id, customerId));
    expect(exists).toHaveLength(1);
  });

  it("hands a tool's error to the model as a route turn does, and finishes done", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const h = await harness(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_bad", CREATE_TOOL, { name: "Без контактів" }),
          stubTextStep("Не вийшло: потрібен телефон або пошта."),
        ]),
      ),
    );

    expect(await h.process(turn.job)).toMatchObject({
      kind: "finished",
      status: "done",
    });
    const stored = await placeholder(turn.placeholderId);
    expect(kinds(stored.parts)).toEqual(["text"]);
    expect(texts(stored.parts)[0]?.status).toBe("complete");
  });

  it("stores `interrupted` when its deadline fires, and keeps the card committed before it", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const late: { harness?: Harness } = {};
    const runtime = afterTool(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_list", LIST_TOOL, {}),
          stubTextStep("не встигне"),
        ]),
      ),
      LIST_TOOL,
      () => {
        late.harness?.fireDeadline();
      },
    );
    const h = await harness(runtime);
    late.harness = h;

    expect(await h.process(turn.job)).toEqual({
      kind: "finished",
      status: "interrupted",
      reachedModel: true,
    });
    const stored = await placeholder(turn.placeholderId);
    expect(kinds(stored.parts)).toEqual(["card", "text"]);
    expect(texts(stored.parts)).toEqual([{ text: "", status: "interrupted" }]);
    expect((await turnRow(turn.commandId)).status).toBe("interrupted");
    expect(await counters(h.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
  });

  it("replays a write the interrupted turn committed when its continuation repeats it: one customer, not two", async () => {
    const email = `katya-${randomUUID()}@example.com`;
    const create = { name: "Катя Продовжити", email };
    const first = await accepted({ history: USER_ASKS });
    const late: { harness?: Harness } = {};
    // The deadline lands inside the write: it commits, the step never finishes,
    // and the model's memory of it is gone.
    const h1 = await harness(
      afterTool(
        runtimeWith(
          stubModel([
            stubToolCallStep("toolu_create", CREATE_TOOL, create),
            stubTextStep("не встигне"),
          ]),
        ),
        CREATE_TOOL,
        () => {
          late.harness?.fireDeadline();
        },
      ),
    );
    late.harness = h1;
    expect(await h1.process(first.job)).toMatchObject({
      status: "interrupted",
    });

    const customersWithEmail = () =>
      kit.db.runtime.db
        .select({ id: companyCustomers.id })
        .from(companyCustomers)
        .where(
          and(
            eq(companyCustomers.companyId, COMPANY),
            eq(companyCustomers.email, email),
          ),
        );
    const afterFirst = await customersWithEmail();
    expect(afterFirst).toHaveLength(1);
    expect(await historyOf(first)).not.toContain("toolu_create");

    // Продовжити: a command of its own, continuing the interrupted one.
    const continuation = await accepted({
      history: USER_ASKS,
      conversationId: first.conversationId,
      continuesCommandId: first.commandId,
    });
    const h2 = await harness(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_create_again", CREATE_TOOL, create),
          stubTextStep("Готово."),
        ]),
      ),
    );
    expect(await h2.process(continuation.job)).toMatchObject({
      kind: "finished",
      status: "done",
    });

    expect(await customersWithEmail()).toEqual(afterFirst);
  });

  it("stops at a step whose history cannot be stored, keeps the card before it, and ends interrupted", async () => {
    const turn = await accepted({ history: USER_ASKS });
    let listCalls = 0;
    const base = afterTool(
      runtimeWith(
        stubModel([
          stubToolCallStep("toolu_first", LIST_TOOL, {}),
          stubToolCallStep("toolu_second", LIST_TOOL, {}),
          stubTextStep("Готово."),
        ]),
      ),
      LIST_TOOL,
      () => {
        listCalls += 1;
      },
    );
    const runtime: AssistantRuntime = {
      ...base,
      forCaller: (caller) => {
        const scoped = base.forCaller(caller);
        return {
          ...scoped,
          history: {
            ...scoped.history,
            save: () => Promise.reject(new Error("history is down")),
          },
        };
      },
    };
    const h = await harness(runtime);

    expect(await h.process(turn.job)).toEqual({
      kind: "finished",
      status: "interrupted",
      reachedModel: true,
    });
    expect(listCalls).toBe(1);
    const stored = await placeholder(turn.placeholderId);
    expect(kinds(stored.parts)).toEqual(["card", "text"]);
    expect(texts(stored.parts)).toEqual([{ text: "", status: "interrupted" }]);
  });

  it("ends interrupted when the log refuses a card, and still ends the text", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const base = runtimeWith(
      stubModel([
        stubToolCallStep("toolu_list", LIST_TOOL, {}),
        stubTextStep("Готово."),
      ]),
    );
    const runtime: AssistantRuntime = {
      ...base,
      forCaller: (caller) => {
        const scoped = base.forCaller(caller);
        return {
          ...scoped,
          kit: {
            ...scoped.kit,
            messages: {
              ...scoped.kit.messages,
              write: (scope, write) =>
                write.kind === "append" &&
                write.parts.some((part) => part.kind === "card")
                  ? Promise.resolve({ kind: "wrong_owner" as const })
                  : scoped.kit.messages.write(scope, write),
            },
          },
        };
      },
    };
    const h = await harness(runtime);

    expect(await h.process(turn.job)).toMatchObject({
      kind: "finished",
      status: "interrupted",
    });
    const stored = await placeholder(turn.placeholderId);
    expect(texts(stored.parts)).toEqual([{ text: "", status: "interrupted" }]);
    expect((await turnRow(turn.commandId)).status).toBe("interrupted");
  });

  it("runs an answer turn from its seeded history exactly as a chat turn, after the card it earned", async () => {
    const earned: ChatPart = {
      kind: "card",
      cardId: "customers-list:earned",
      revision: 1,
      type: "customers-list",
      payload: { rows: 1 },
    };
    const turn = await accepted({
      history: [
        { role: "user", content: "видали Катю" },
        { role: "assistant", content: "Видалено." },
      ],
      answerEarned: [earned],
    });
    const h = await harness(runtimeWith(stubModel([stubTextStep("Готово.")])));

    expect(await h.process(turn.job)).toMatchObject({
      kind: "finished",
      status: "done",
    });
    const stored = await placeholder(turn.placeholderId);
    expect(stored.parts).toEqual([
      earned,
      { kind: "text", text: "Готово.", status: "complete" },
    ]);
  });

  it("releases exactly the hold finishTurn returned when the model was never reached", async () => {
    const budget = await seededBudget(COUNTER_BEFORE - HOLD.companyReservedUsd);
    const turn = await accepted({ history: USER_ASKS, budget });
    const never = modelThatMustNotRun();
    const base = runtimeWith(never.model);
    const h = await harness(
      {
        ...base,
        tools: () => Promise.reject(new Error("permissions could not be read")),
      },
      budget,
    );

    expect(await h.process(turn.job)).toEqual({
      kind: "finished",
      status: "interrupted",
      reachedModel: false,
    });
    expect(never.calls.count).toBe(0);
    const released = await counters(h.budget);
    expect(released.company).toBeCloseTo(
      COUNTER_BEFORE - HOLD.companyReservedUsd,
    );
    expect(released.global).toBeCloseTo(
      COUNTER_BEFORE - HOLD.globalReservedUsd,
    );
    expect((await turnRow(turn.commandId)).companyReservedMicroUsd).toBe(0);
    expect(texts((await placeholder(turn.placeholderId)).parts)).toEqual([
      { text: "", status: "interrupted" },
    ]);
  });

  it("runs nothing for a job whose turn has already started", async () => {
    const turn = await accepted({ history: USER_ASKS });
    let modelCalls = 0;
    const h = await harness(
      runtimeWith(
        stubModelFailingAfter([stubTextStep("Готово.")], {
          before: () => {
            modelCalls += 1;
          },
        }),
      ),
    );

    expect(await h.process(turn.job)).toMatchObject({ status: "done" });
    const published = h.published.length;

    // A duplicate or replayed job for the same turn.
    expect(await h.process({ ...turn.job })).toEqual({
      kind: "not_queued",
      status: "done",
    });
    expect(modelCalls).toBe(0);
    expect(h.published).toHaveLength(published);
  });

  it("runs and writes nothing for an author who lost membership: core refuses the start and the turn stays queued", async () => {
    const marta = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: marta,
      name: "Marta Former",
      email: `marta-${marta}@assistant-worker.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: COMPANY,
      userId: marta,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    const turn = await accepted({ history: USER_ASKS, userId: marta });
    await kit.db.runtime.db
      .delete(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, COMPANY),
          eq(companyMembers.userId, marta),
        ),
      );
    const never = modelThatMustNotRun();
    const h = await harness(runtimeWith(never.model));
    const before = await placeholder(turn.placeholderId);

    const outcome = await h.process(turn.job);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(never.calls.count).toBe(0);
    expect((await turnRow(turn.commandId)).status).toBe("queued");
    expect(await placeholder(turn.placeholderId)).toEqual(before);
    expect(texts(before.parts)).toEqual([{ text: "", status: "streaming" }]);
    expect(h.published).toEqual([]);
    expect(await counters(h.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
  });
});

describe("a turn that broke rather than stopped", () => {
  it("stores `error` and finishes failed when the provider fails, keeping the hold as the charge", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const h = await harness(runtimeWith(stubModelFailingAfter([])));

    expect(await h.process(turn.job)).toEqual({
      kind: "finished",
      status: "failed",
      reachedModel: true,
    });
    expect(texts((await placeholder(turn.placeholderId)).parts)).toEqual([
      { text: "", status: "error" },
    ]);
    expect((await turnRow(turn.commandId)).status).toBe("failed");
    expect(await counters(h.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
    // Not offered as a turn to continue: the event says it failed.
    expect(h.published.at(-1)?.event).toMatchObject({
      type: "turn.finished",
      status: "failed",
    });
  });

  it("finishes failed when a tool asks for a pause the registry refuses", async () => {
    const turn = await accepted({ history: USER_ASKS });
    const base = runtimeWith(
      stubModel([stubToolCallStep("toolu_list", LIST_TOOL, {})]),
    );
    const h = await harness({
      ...base,
      tools: async (context) => {
        const set = await base.tools(context);
        const definition = set[LIST_TOOL];
        const execute = definition?.execute;
        if (definition === undefined || execute === undefined) {
          throw new Error(`${LIST_TOOL} is not offered`);
        }
        const wrapped: ToolSet = { ...set };
        wrapped[LIST_TOOL] = {
          ...definition,
          execute: async (input, options) => {
            await execute(input, options);
            const refused: ToolOutcome = {
              kind: "pause",
              interaction: "not_registered",
              prompt: {},
              secret: {},
            };
            return refused;
          },
        };
        return wrapped;
      },
    });

    expect(await h.process(turn.job)).toMatchObject({
      kind: "finished",
      status: "failed",
    });
    expect(texts((await placeholder(turn.placeholderId)).parts)).toEqual([
      { text: "", status: "error" },
    ]);
    expect((await turnRow(turn.commandId)).status).toBe("failed");
  });
});

describe("an author removed while the turn runs", () => {
  it("is refused at the next action: nothing is created, nothing reads as done, and the turn is left to the reconciler", async () => {
    const member = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id: member,
      name: "Oles Leaving",
      email: `oles-${member}@assistant-worker.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: COMPANY,
      userId: member,
      role: "employee",
      permissions: {
        granted: ["assistant:use", "customers:view", "customers:create"],
        denied: [],
      },
    });
    const turn = await accepted({ history: USER_ASKS, userId: member });
    const email = `oles-customer-${member}@example.com`;
    const h = await harness(
      afterTool(
        runtimeWith(
          stubModel([
            stubToolCallStep("toolu_list", LIST_TOOL, {}),
            stubToolCallStep("toolu_create", CREATE_TOOL, {
              name: "Не створиться",
              email,
            }),
            stubTextStep("Готово."),
          ]),
        ),
        LIST_TOOL,
        async () => {
          await kit.db.runtime.db
            .delete(companyMembers)
            .where(
              and(
                eq(companyMembers.companyId, COMPANY),
                eq(companyMembers.userId, member),
              ),
            );
        },
      ),
    );

    // Core refuses even the finish as this person; the job host catches it.
    await expect(h.process(turn.job)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    const created = await kit.db.runtime.db
      .select({ id: companyCustomers.id })
      .from(companyCustomers)
      .where(eq(companyCustomers.email, email));
    expect(created).toEqual([]);
    const statuses = texts((await placeholder(turn.placeholderId)).parts).map(
      (part) => part.status,
    );
    expect(statuses).not.toContain("complete");
    expect((await turnRow(turn.commandId)).status).toBe("running");
    expect(h.published.map((entry) => entry.event.type)).toEqual([
      "turn.started",
    ]);
  });
});

describe("a tool action's client address", () => {
  it("is still the request's on an HTTP path", async () => {
    const tools = await seedingRuntime().tools({
      userId: ANNA,
      companySelector: COMPANY,
      conversationId: randomUUID(),
      commandId: randomUUID(),
      requestId: randomUUID(),
      clientIp: "203.0.113.7",
    });
    const execute = tools[LIST_TOOL]?.execute;
    if (execute === undefined) {
      throw new Error(`${LIST_TOOL} is not offered`);
    }

    await execute({}, { toolCallId: "toolu_http", messages: [] } as never);

    expect(
      invocations
        .filter((entry) => entry.action === "customers.listCustomers")
        .map((entry) => entry.clientIp),
    ).toEqual(["203.0.113.7"]);
  });
});
