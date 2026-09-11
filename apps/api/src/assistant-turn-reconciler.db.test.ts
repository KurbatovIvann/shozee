/**
 * The reconciler against a real database (ADR-0039, SHO-570).
 *
 * Everything these tests claim about time is a comparison Postgres makes
 * against its own clock: rows are aged in SQL, never by a time this process
 * computed. What is a clock here is the reconciler's re-enqueue backoff, which
 * is its own and is injected.
 *
 * The reconciler acts on every stale turn the database lists, across companies,
 * so each test asserts about its own turn rather than about a pass's totals.
 */
import { randomUUID } from "node:crypto";

import type { ChatPart } from "@showzy/assistant-kit";
import {
  ASSISTANT_REENQUEUE_BACKOFF_MS,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  assistantTurnJobId,
  createAssistantRuntime,
  createAssistantTurnProcessor,
  createAssistantTurnReconciler,
  createMemoryAiBudgetStore,
  createPostgresAssistantTurnStore,
  type AiBudgetStore,
  type AssistantRuntime,
  type AssistantTurnJob,
  type AssistantTurnQueue,
  type StaffAssistantBudgetHold,
} from "@showzy/assistant-runtime";
import type { ActionPipelineDeps } from "@showzy/core";
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
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { and, eq, sql } from "drizzle-orm";
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
/** The same hold as the turn row stores it. */
const HOLD_MICRO_USD = 100_000;
/** What the day's counters hold before a turn: this turn's hold and others'. */
const COUNTER_BEFORE = 0.35;
const TIMEOUT_MS = 180_000;

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;
let pipeline: ActionPipelineDeps;
const registry = createActionRegistry();

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
  pipeline = kit.pipeline;
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

beforeEach(async () => {
  await redis.flushall();
});

function runtimeOn(deps: ActionPipelineDeps = pipeline): AssistantRuntime {
  // No turn here reaches a model: the reconciler only reads and writes.
  return createAssistantRuntime({
    registry,
    pipeline: deps,
    model: "mock",
    redis,
  });
}

function callerOf(userId: string) {
  return { userId, companySelector: COMPANY, requestId: randomUUID() };
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
  readonly turn: {
    readonly conversationId: string;
    readonly kind: "chat";
    readonly commandId: string;
  };
}

async function accepted(options?: {
  readonly userId?: string;
  readonly conversationId?: string;
  /** Sent by a client in any casing, as a phone may. */
  readonly upperCaseIds?: boolean;
}): Promise<Accepted> {
  const userId = options?.userId ?? ANNA;
  const conversationId =
    options?.conversationId ?? (await newConversation(userId));
  const commandId = randomUUID();
  const sent = {
    conversationId: options?.upperCaseIds
      ? conversationId.toUpperCase()
      : conversationId,
    commandId: options?.upperCaseIds ? commandId.toUpperCase() : commandId,
  };
  const result = await createPostgresAssistantTurnStore(
    { pipeline },
    callerOf(userId),
  ).accept({
    kind: "chat",
    conversationId: sent.conversationId,
    commandId: sent.commandId,
    bind: bindOf(userId),
    text: "покажи клієнтів",
    sessionId: `session-${userId}`,
    budgetHold: HOLD,
    releaseUnusedHold: () => Promise.resolve(),
  });
  if (result.outcome !== "accepted") {
    throw new Error(`expected an accepted turn, got ${result.outcome}`);
  }
  return {
    job: result.job,
    conversationId,
    commandId,
    placeholderId: result.turn.placeholderMessageId,
    userId,
    turn: { conversationId, kind: "chat", commandId },
  };
}

async function startTurn(turn: Accepted): Promise<void> {
  const started = await createPostgresAssistantTurnStore(
    { pipeline },
    callerOf(turn.userId),
  ).start(turn.turn, { timeoutMs: TIMEOUT_MS });
  if (started.outcome !== "started") {
    throw new Error(`expected a started turn, got ${started.outcome}`);
  }
}

/** Ages a turn in SQL: the container's clock is not this process's. */
async function ageTurn(conversationId: string, age: string): Promise<void> {
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({ createdAt: sql`now() - ${age}::interval` })
    .where(eq(assistantTurns.conversationId, conversationId));
}

async function passDeadline(conversationId: string): Promise<void> {
  await kit.db.runtime.db
    .update(assistantTurns)
    .set({ deadlineAt: sql`now() - interval '1 second'` })
    .where(
      and(
        eq(assistantTurns.conversationId, conversationId),
        eq(assistantTurns.status, "running"),
      ),
    );
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

async function turnRow(commandId: string) {
  const row = (
    await kit.db.runtime.db
      .select({
        status: assistantTurns.status,
        startedAt: assistantTurns.startedAt,
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

/**
 * The queue as the reconciler sees it: a job added stays until something takes
 * it. `drain` is a worker taking every waiting job and finishing it, which is
 * what removes it (`removeOnComplete`) — including the turn that was refused at
 * start and stayed queued.
 */
function memoryQueue() {
  const added: { jobId: string; data: AssistantTurnJob }[] = [];
  const pending = new Set<string>();
  const queue: AssistantTurnQueue = {
    add: (_name, data, opts) => {
      added.push({ jobId: opts.jobId, data });
      pending.add(opts.jobId);
      return Promise.resolve(undefined);
    },
    getJob: (jobId) =>
      Promise.resolve(pending.has(jobId) ? { id: jobId } : undefined),
  };
  return {
    queue,
    added,
    hold: (job: AssistantTurnJob) => pending.add(assistantTurnJobId(job)),
    drain: () => {
      pending.clear();
    },
  };
}

interface Pass {
  run(): Promise<void>;
  /** A job the queue is still holding for this turn. */
  hold(job: AssistantTurnJob): void;
  /** Every waiting job taken and finished, so none is left. */
  drain(): void;
  readonly added: { jobId: string; data: AssistantTurnJob }[];
  readonly published: {
    readonly address: { readonly conversationId: string };
    readonly event: AssistantPublishedEvent;
  }[];
  readonly budget: AiBudgetStore;
}

async function reconciler(options?: {
  readonly budget?: AiBudgetStore;
  readonly clock?: { ms: number };
  readonly deps?: ActionPipelineDeps;
}): Promise<Pass> {
  const budget = options?.budget ?? (await seededBudget());
  const published: Pass["published"] = [];
  const { queue, added, hold, drain } = memoryQueue();
  const deps = options?.deps ?? pipeline;
  const clock = options?.clock;
  const reconcile = createAssistantTurnReconciler({
    runtime: runtimeOn(deps),
    pipeline: deps,
    budgetStore: budget,
    publisher: {
      publish: (address, event) => {
        published.push({ address, event });
        return Promise.resolve();
      },
    },
    ...(clock === undefined ? {} : { now: () => clock.ms }),
  });
  return {
    added,
    published,
    budget,
    hold,
    drain,
    run: async () => {
      await reconcile(queue);
    },
  };
}

/** Events this pass published about one turn. */
function about(pass: Pass, turn: Accepted): AssistantPublishedEvent[] {
  return pass.published
    .filter((entry) => entry.address.conversationId === turn.conversationId)
    .map((entry) => entry.event);
}

function enqueuedIds(pass: Pass, turn: Accepted): string[] {
  return pass.added
    .filter((entry) => entry.data.commandId === turn.commandId)
    .map((entry) => entry.jobId);
}

/**
 * A pipeline whose first call of `action` runs `before` first — the seam these
 * tests force an interleaving with. The hook runs before the action's
 * transaction opens, so a caller that has already read something has read it,
 * and what it then writes meets whatever `before` stored.
 */
function gatedOn(
  action: string,
  before: () => Promise<void>,
): ActionPipelineDeps {
  let fired = false;
  return {
    ...pipeline,
    hooks: {
      ...pipeline.hooks,
      rateLimit: {
        enforce: async (env) => {
          if (!fired && env.contract.name === action) {
            fired = true;
            await before();
          }
          await pipeline.hooks?.rateLimit?.enforce(env);
        },
      },
    },
  };
}

describe("a turn whose job was lost", () => {
  it("is enqueued again under the id the accept derived, whatever casing the client sent, and then backs off", async () => {
    const turn = await accepted({ upperCaseIds: true });
    await ageTurn(turn.conversationId, "5 minutes");
    const clock = { ms: 1_000_000 };
    const pass = await reconciler({ clock });
    const derivedAtAccept = assistantTurnJobId({
      kind: "chat",
      conversationId: turn.conversationId.toUpperCase(),
      commandId: turn.commandId.toUpperCase(),
    });

    await pass.run();
    expect(enqueuedIds(pass, turn)).toEqual([derivedAtAccept]);
    expect(assistantTurnJobId(turn.job)).toBe(derivedAtAccept);

    // The job ran, was refused at start and was removed; the turn is queued
    // again with nothing holding it.
    pass.drain();
    // Without a backoff this pass — and every pass after it — would enqueue it
    // again, for as long as the turn existed.
    await pass.run();
    expect(enqueuedIds(pass, turn)).toEqual([derivedAtAccept]);

    clock.ms += ASSISTANT_REENQUEUE_BACKOFF_MS;
    await pass.run();
    expect(enqueuedIds(pass, turn)).toHaveLength(2);
    pass.drain();

    // And the wait doubles: one more interval is not yet enough.
    clock.ms += ASSISTANT_REENQUEUE_BACKOFF_MS;
    await pass.run();
    expect(enqueuedIds(pass, turn)).toHaveLength(2);

    // Nothing else happened to it: it is queued, holding its conversation.
    expect(await turnRow(turn.commandId)).toMatchObject({ status: "queued" });
    expect(about(pass, turn)).toEqual([]);
    expect(await counters(pass.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
  });
});

describe("a turn whose worker is gone", () => {
  it("is interrupted past its deadline, keeps its hold as the charge, ends its text and publishes only the status", async () => {
    const turn = await accepted();
    await startTurn(turn);
    await passDeadline(turn.conversationId);
    const pass = await reconciler();

    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      companyReservedMicroUsd: 0,
    });
    // It cannot know whether that turn reached the model, so the reservation
    // stands as the charge (ADR-0039).
    expect(await counters(pass.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
    expect((await placeholder(turn.placeholderId)).parts).toEqual([
      { kind: "text", text: "", status: "interrupted" },
    ]);
    // The status, and nothing of the conversation: no window, no message.
    expect(about(pass, turn)).toEqual([
      {
        type: "turn.finished",
        kind: "chat",
        commandId: turn.commandId,
        status: "interrupted",
      },
    ]);
    expect(enqueuedIds(pass, turn)).toEqual([]);
  });

  it("does not enqueue it again: a started turn is never run twice", async () => {
    const turn = await accepted();
    await startTurn(turn);
    await passDeadline(turn.conversationId);
    const pass = await reconciler();

    await pass.run();
    await pass.run();

    expect(pass.added).toEqual(
      pass.added.filter((entry) => entry.data.commandId !== turn.commandId),
    );
    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
    });
  });
});

describe("a queued turn behind a backlog", () => {
  /**
   * Age alone is not abandonment. One worker runs 4 turns at once, each up to
   * 180 s — about 1.33 turns a minute at worst — so twenty turns ahead of this
   * one put it past fifteen minutes while it is perfectly healthy. What tells
   * the two apart is whether the queue still holds its job.
   */
  it("is left alone while its job waits, however long it has been queued, and ended once that job is gone", async () => {
    const turn = await accepted();
    await ageTurn(turn.conversationId, "16 minutes");
    const pass = await reconciler();
    pass.hold(turn.job);

    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "queued",
      companyReservedMicroUsd: HOLD_MICRO_USD,
    });
    expect(about(pass, turn)).toEqual([]);
    expect(await counters(pass.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
    // It is not re-enqueued either: the queue is already holding it.
    expect(enqueuedIds(pass, turn)).toEqual([]);

    // The job ran, was refused at start, and was removed. Now nothing will
    // start this turn, and the same threshold ends it.
    pass.drain();
    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      startedAt: null,
      companyReservedMicroUsd: 0,
    });
    expect((await counters(pass.budget)).company).toBeCloseTo(
      COUNTER_BEFORE - HOLD.companyReservedUsd,
    );
  });
});

describe("a queued turn that can never start", () => {
  it("is ended past the abandon threshold, its hold given back, and its conversation freed", async () => {
    const turn = await accepted();
    await ageTurn(turn.conversationId, "16 minutes");
    const pass = await reconciler();

    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      startedAt: null,
      companyReservedMicroUsd: 0,
    });
    // It never reached the model, so the reservation goes back once.
    const released = await counters(pass.budget);
    expect(released.company).toBeCloseTo(
      COUNTER_BEFORE - HOLD.companyReservedUsd,
    );
    expect(released.global).toBeCloseTo(
      COUNTER_BEFORE - HOLD.globalReservedUsd,
    );
    expect((await placeholder(turn.placeholderId)).parts).toEqual([
      { kind: "text", text: "", status: "interrupted" },
    ]);
    expect(about(pass, turn)).toEqual([
      {
        type: "turn.finished",
        kind: "chat",
        commandId: turn.commandId,
        status: "interrupted",
      },
    ]);

    // The conversation takes a new turn.
    const next = await accepted({ conversationId: turn.conversationId });
    expect(await turnRow(next.commandId)).toMatchObject({ status: "queued" });
  });

  it("never takes a counter below zero when the hold is larger than what is on it", async () => {
    const turn = await accepted();
    await ageTurn(turn.conversationId, "16 minutes");
    // Less on the day's counters than this turn reserved: a restart lost them.
    const pass = await reconciler({ budget: await seededBudget(0.05) });

    await pass.run();

    expect(await counters(pass.budget)).toEqual({ company: 0, global: 0 });
    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
    });
  });

  it("is left alone when a worker started it between the list and the interrupt", async () => {
    const turn = await accepted();
    await ageTurn(turn.conversationId, "16 minutes");
    const pass = await reconciler({
      deps: gatedOn("assistant.interruptTurn", async () => {
        await startTurn(turn);
      }),
    });

    await pass.run();

    // The database re-decides staleness inside the interrupt: it is running now.
    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "running",
      companyReservedMicroUsd: HOLD_MICRO_USD,
    });
    expect(await counters(pass.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
    expect(about(pass, turn)).toEqual([]);
    expect((await placeholder(turn.placeholderId)).parts).toEqual([
      { kind: "text", text: "", status: "streaming" },
    ]);
  });
});

describe("the worker and the reconciler reaching one row", () => {
  it("gives the hold back once when the reconciler ends the turn as the worker starts it", async () => {
    const turn = await accepted();
    await ageTurn(turn.conversationId, "16 minutes");
    const budget = await seededBudget();
    const pass = await reconciler({ budget });
    // The worker's start meets a turn the reconciler ended a moment before.
    const worker = createAssistantTurnProcessor({
      runtime: runtimeOn(),
      pipeline: gatedOn("assistant.startTurn", () => pass.run()),
      budgetStore: budget,
      publisher: { publish: () => Promise.resolve() },
    });

    const outcome = await worker(turn.job);

    expect(outcome).toEqual({ kind: "not_queued", status: "interrupted" });
    // Exactly one release: the interrupt's. The worker took no hold to give.
    const released = await counters(budget);
    expect(released.company).toBeCloseTo(
      COUNTER_BEFORE - HOLD.companyReservedUsd,
    );
    expect(released.global).toBeCloseTo(
      COUNTER_BEFORE - HOLD.globalReservedUsd,
    );
    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      startedAt: null,
      companyReservedMicroUsd: 0,
    });
  });

  it("keeps both a late card and the interrupted text when the two writes cross", async () => {
    const turn = await accepted();
    await startTurn(turn);
    await passDeadline(turn.conversationId);
    const pass = await reconciler();
    const card: ChatPart = {
      kind: "card",
      cardId: "customers-list:late",
      revision: 1,
      type: "customers-list",
      payload: { rows: 1 },
    };
    // A worker still inside a tool: it has read the message, and the reconciler
    // stores the interrupted text before its own store lands.
    const late = runtimeOn(
      gatedOn("assistant.updateChatMessage", () => pass.run()),
    ).forCaller(callerOf(turn.userId)).kit;

    const written = await late.messages.write(
      { conversationId: turn.conversationId, bind: bindOf(turn.userId) },
      {
        kind: "append",
        messageId: turn.placeholderId,
        role: "assistant",
        parts: [card],
      },
    );

    expect(written).toEqual({ kind: "written" });
    const stored = await placeholder(turn.placeholderId);
    // Neither write was lost: the card read the message again and applied
    // itself to the text the reconciler had settled.
    expect(stored.parts).toEqual([
      { kind: "text", text: "", status: "interrupted" },
      card,
    ]);
    expect(stored.revision).toBe(3);
    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
    });
  });
});

describe("a turn whose author is no longer a member", () => {
  async function member(): Promise<string> {
    const id = randomUUID();
    await kit.db.runtime.db.insert(user).values({
      id,
      name: "Oles Leaving",
      email: `oles-${id}@assistant-reconciler.test`,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: COMPANY,
      userId: id,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    return id;
  }

  async function remove(userId: string): Promise<void> {
    await kit.db.runtime.db
      .delete(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, COMPANY),
          eq(companyMembers.userId, userId),
        ),
      );
  }

  it("is ended while queued, its hold released, and its conversation takes a new turn once they are back", async () => {
    const userId = await member();
    const turn = await accepted({ userId });
    await remove(userId);
    await ageTurn(turn.conversationId, "16 minutes");
    const pass = await reconciler();

    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      companyReservedMicroUsd: 0,
    });
    const released = await counters(pass.budget);
    expect(released.company).toBeCloseTo(
      COUNTER_BEFORE - HOLD.companyReservedUsd,
    );
    // Nobody can be acted as, so the text keeps the status it has: the turn is
    // ended and the conversation is free either way.
    expect((await placeholder(turn.placeholderId)).parts).toEqual([
      { kind: "text", text: "", status: "streaming" },
    ]);
    expect(about(pass, turn)).toEqual([
      {
        type: "turn.finished",
        kind: "chat",
        commandId: turn.commandId,
        status: "interrupted",
      },
    ]);

    await kit.db.runtime.db.insert(companyMembers).values({
      companyId: COMPANY,
      userId,
      role: "employee",
      permissions: { granted: ["assistant:use"], denied: [] },
    });
    const next = await accepted({
      userId,
      conversationId: turn.conversationId,
    });
    expect(await turnRow(next.commandId)).toMatchObject({ status: "queued" });
  });

  it("is ended while running once its deadline passes, with its hold kept as the charge", async () => {
    const userId = await member();
    const turn = await accepted({ userId });
    await startTurn(turn);
    await remove(userId);
    await passDeadline(turn.conversationId);
    const pass = await reconciler();

    await pass.run();

    expect(await turnRow(turn.commandId)).toMatchObject({
      status: "interrupted",
      companyReservedMicroUsd: 0,
    });
    expect(await counters(pass.budget)).toEqual({
      company: COUNTER_BEFORE,
      global: COUNTER_BEFORE,
    });
  });
});
