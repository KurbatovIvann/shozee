import { randomUUID } from "node:crypto";

import { domainEvents, eventDeliveries, type Tx } from "@showzy/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConflictError,
  CoreError,
  CoreInvariantError,
} from "../../errors/index.js";
import { defineJob } from "../../jobs/define-job.js";
import { jobField, jobPayload } from "../../jobs/job-payload.js";
import {
  buildJobEnvelope,
  createTestKit,
  type TestKit,
} from "../../testing/kit.js";
import { defineEventHandler } from "../events/define-event-handler.js";
import { defineEvent } from "../events/define-event.js";
import { dispatchOutboxBatch, executeDelivery } from "../events/delivery.js";
import { eventEnvelopeSchema } from "../events/envelope.js";
import { implementAction } from "../implement-action.js";
import { UUID_PATTERN } from "../patterns.js";
import type { ActionTransactionRunner } from "../pipeline/types.js";
import type { JobPort } from "./enqueue.js";

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
});

afterAll(async () => {
  await kit.db.close();
});

beforeEach(() => {
  kit.jobs.clear();
});

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const expiring = {
  scope: "tenant",
  discriminator: [],
  lifecycle: "expires",
  retries: 0,
  attemptTimeoutMs: 1_000,
} as const;

const runTurn = defineJob({
  ...expiring,
  name: "jobKit.runTurn",
  payload: jobPayload({ turnId: jobField.uuid() }),
  onExhausted: "jobKit.interruptTurn",
});
const sendReminder = defineJob({
  ...expiring,
  name: "jobKit.sendReminder",
  payload: jobPayload({ reminderId: jobField.uuid() }),
  discriminator: ["reminderId"],
  onExhausted: "jobKit.dropReminder",
});
const undeclaredJob = defineJob({
  ...expiring,
  name: "jobKit.undeclared",
  payload: jobPayload({ turnId: jobField.uuid() }),
  onExhausted: "jobKit.interruptTurn",
});
const calleeJob = defineJob({
  ...expiring,
  name: "jobKitCallee.holdJob",
  payload: jobPayload({ turnId: jobField.uuid() }),
  onExhausted: "jobKitCallee.release",
});
const workerRunTurn = defineJob({
  ...expiring,
  name: "jobKitWorker.runTurn",
  payload: jobPayload({ turnId: jobField.uuid() }),
  onExhausted: "jobKitWorker.interruptTurn",
});

const noted = defineEvent({
  name: "jobKit.noted",
  version: 1,
  scope: "tenant",
  payload: z.object({ turnId: z.uuid() }),
});

const systemWrite = {
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  aiExposure: "internal",
  permissions: [],
  risk: "write",
  requiresConfirmation: false,
  atomicCalls: [],
  atomicCallers: [],
  audit: true,
  timeout: 5_000,
} as const;

const auditTarget = () => ({ type: "turn", id: "fixture" });

const noteModes = [
  "ok",
  "throw",
  "emit",
  "undeclared",
  "fanOutWithoutDiscriminator",
  "sameDiscriminator",
] as const;

const noteAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKit.note",
    description: "Non-idempotent fixture enqueueing jobs.",
    input: z.object({
      turnId: z.uuid(),
      reminderIds: z.array(z.uuid()).default([]),
      mode: z.enum(noteModes).default("ok"),
    }),
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    emits: ["jobKit.noted"],
    enqueues: ["jobKit.runTurn", "jobKit.sendReminder"],
    errors: ["CONFLICT"],
  }),
  {
    handler: (input, ctx) => {
      const { turnId, mode } = input;
      if (mode === "undeclared") {
        ctx.enqueue(undeclaredJob, { turnId });
      } else if (mode === "sameDiscriminator") {
        ctx.enqueue(sendReminder, { reminderId: turnId });
        ctx.enqueue(sendReminder, { reminderId: turnId });
      } else {
        ctx.enqueue(runTurn, { turnId });
        if (mode === "fanOutWithoutDiscriminator") {
          ctx.enqueue(runTurn, { turnId });
        }
      }
      for (const reminderId of input.reminderIds) {
        ctx.enqueue(sendReminder, { reminderId });
      }
      if (mode === "emit") {
        ctx.emit(noted, {
          aggregate: { type: "turn", id: turnId },
          payload: { turnId },
        });
      }
      if (mode === "throw") {
        throw new ConflictError("Injected enqueue-then-fail.");
      }
      return Promise.resolve({ ok: true });
    },
    auditTarget,
  },
);

let acceptRuns = 0;
const acceptAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKit.accept",
    description: "Idempotent fixture enqueueing one turn job.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    idempotent: true,
    emits: [],
    enqueues: ["jobKit.runTurn"],
    errors: [],
  }),
  {
    handler: (input, ctx) => {
      acceptRuns += 1;
      ctx.enqueue(runTurn, { turnId: input.turnId });
      return Promise.resolve({ ok: true });
    },
    auditTarget,
  },
);

const peekAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKit.peek",
    description: "Read fixture that tries to enqueue.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    risk: "read",
    audit: false,
    idempotent: false,
    emits: [],
    errors: [],
  }),
  {
    handler: (input, ctx) => {
      ctx.enqueue(runTurn, { turnId: input.turnId });
      return Promise.resolve({ ok: true });
    },
  },
);

const calleePeekAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKitCallee.peek",
    description: "ctx.call callee that tries to enqueue.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    risk: "read",
    audit: false,
    idempotent: false,
    emits: [],
    errors: [],
  }),
  {
    handler: (input, ctx) => {
      ctx.enqueue(calleeJob, { turnId: input.turnId });
      return Promise.resolve({ ok: true });
    },
  },
);

const lookupAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKit.lookup",
    description: "Root calling a read callee that enqueues.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    emits: [],
    errors: [],
  }),
  {
    handler: (input, ctx) => ctx.call(calleePeekAction, input),
    auditTarget,
  },
);

const holdAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKitCallee.hold",
    description: "Atomic callee that tries to enqueue.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    atomicCallers: ["jobKit.reserve"],
    idempotent: false,
    emits: [],
    enqueues: ["jobKitCallee.holdJob"],
    errors: [],
  }),
  {
    handler: (input, ctx) => {
      ctx.enqueue(calleeJob, { turnId: input.turnId });
      return Promise.resolve({ ok: true });
    },
    auditTarget,
  },
);

const reserveAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKit.reserve",
    description: "Atomic root whose callee enqueues.",
    input: z.object({ turnId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    atomicCalls: ["jobKitCallee.hold"],
    idempotent: true,
    emits: [],
    errors: [],
  }),
  {
    handler: (input, ctx) => ctx.callAtomic(holdAction, input),
    auditTarget,
  },
);

const failStartFor = new Set<string>();
const startTurnAction = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobKitWorker.startTurn",
    description: "Event consumer enqueueing the worker's turn job.",
    input: eventEnvelopeSchema(z.object({ turnId: z.uuid() })),
    output: z.object({ ok: z.boolean() }),
    idempotent: true,
    emits: [],
    enqueues: ["jobKitWorker.runTurn"],
    errors: ["CONFLICT"],
  }),
  {
    handler: (input, ctx) => {
      ctx.enqueue(workerRunTurn, { turnId: input.payload.turnId });
      if (failStartFor.has(input.payload.turnId)) {
        throw new ConflictError("Injected delivery failure.");
      }
      return Promise.resolve({ ok: true });
    },
    auditTarget,
  },
);

const startTurnSubscription = defineEventHandler({
  event: noted,
  consumer: "jobKitWorker.turn-starter",
  action: startTurnAction,
});

async function expectRefused(
  run: Promise<unknown>,
  detail: string,
): Promise<void> {
  const error: unknown = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CoreInvariantError);
  expect(error instanceof CoreError ? error.message : "").toContain(detail);
}

function signal(): { readonly fired: Promise<void>; fire(): void } {
  let settle = (): void => undefined;
  const fired = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    fired,
    fire() {
      settle();
    },
  };
}

async function emitNoted(turnId: string): Promise<string> {
  const requestId = randomUUID();
  await kit.invoke(
    noteAction,
    { turnId, mode: "emit" },
    {},
    { request: { requestId } },
  );
  kit.jobs.clear();
  const rows = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one emitted outbox row");
  }
  await dispatchOutboxBatch(
    { db: kit.db.runtime.db },
    { subscriptions: [startTurnSubscription], claimedBy: "jobs-test" },
  );
  return row.id;
}

describe("ctx.enqueue commit and rollback (J1)", () => {
  it("delivers the envelope with the verified scope at commit", async () => {
    const turnId = randomUUID();
    const requestId = randomUUID();
    const correlationId = randomUUID();

    await kit.invoke(
      noteAction,
      { turnId },
      {},
      { request: { requestId, correlationId } },
    );

    expect(kit.jobs.sent).toHaveLength(1);
    const envelope = kit.jobs.sent[0];
    expect(envelope).toMatchObject({
      name: "jobKit.runTurn",
      companyId: kit.identities.companies.a,
      actor: { type: "system", id: "test-kit" },
      channel: "ui",
      requestId,
      correlationId,
      payload: { turnId },
    });
    expect(envelope?.executionId).toMatch(UUID_V7);
    expect(envelope?.executionId).not.toBe(requestId);
    expect(envelope?.id).toMatch(UUID_PATTERN);
  });

  it("leaves nothing at the port when the handler rolls back", async () => {
    await expect(
      kit.invoke(noteAction, { turnId: randomUUID(), mode: "throw" }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("records nothing from a run whose hook fails after the send", async () => {
    const keptTurnId = randomUUID();
    await kit.invoke(noteAction, { turnId: keptTurnId });
    const hooks = {
      ...kit.pipeline.hooks,
      audit: {
        recordSuccess: () =>
          Promise.reject(new CoreInvariantError("injected audit failure")),
        recordFailure: () => Promise.resolve(),
      },
    };

    await expect(
      kit.invoke(
        noteAction,
        { turnId: randomUUID() },
        {},
        { deps: { ...kit.pipeline, hooks } },
      ),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(kit.jobs.sent.map((envelope) => envelope.payload)).toEqual([
      { turnId: keptTurnId },
    ]);
  });

  it("keeps a committed run's envelopes while an overlapping run with the same request id fails after the send", async () => {
    const keptTurnId = randomUUID();
    const requestId = randomUUID();
    const failingReachedAudit = signal();
    const committedRunDone = signal();
    const hooks = {
      ...kit.pipeline.hooks,
      audit: {
        recordSuccess: async () => {
          failingReachedAudit.fire();
          await committedRunDone.fired;
          throw new CoreInvariantError("injected audit failure");
        },
        recordFailure: () => Promise.resolve(),
      },
    };

    const failing = kit.invoke(
      noteAction,
      { turnId: randomUUID() },
      {},
      { request: { requestId }, deps: { ...kit.pipeline, hooks } },
    );
    await failingReachedAudit.fired;
    await kit.invoke(
      noteAction,
      { turnId: keptTurnId },
      {},
      { request: { requestId } },
    );
    expect(kit.jobs.sent.map((envelope) => envelope.payload)).toEqual([
      { turnId: keptTurnId },
    ]);
    committedRunDone.fire();

    await expect(failing).rejects.toBeInstanceOf(CoreInvariantError);
    expect(kit.jobs.sent.map((envelope) => envelope.payload)).toEqual([
      { turnId: keptTurnId },
    ]);
  });

  it("records only the committed runs while failing runs hold their sends open across those commits", async () => {
    const committedTurnIds = [randomUUID(), randomUUID(), randomUUID()];
    const allFailingReachedAudit = signal();
    const committedRunsDone = signal();
    let failingAtAudit = 0;
    const hooks = {
      ...kit.pipeline.hooks,
      audit: {
        recordSuccess: async () => {
          failingAtAudit += 1;
          if (failingAtAudit === committedTurnIds.length) {
            allFailingReachedAudit.fire();
          }
          await committedRunsDone.fired;
          throw new CoreInvariantError("injected audit failure");
        },
        recordFailure: () => Promise.resolve(),
      },
    };

    const failing = committedTurnIds.map(() =>
      kit.invoke(
        noteAction,
        { turnId: randomUUID() },
        {},
        { deps: { ...kit.pipeline, hooks } },
      ),
    );
    await allFailingReachedAudit.fired;
    const committed = await Promise.allSettled(
      committedTurnIds.map((turnId) => kit.invoke(noteAction, { turnId })),
    );
    expect(
      kit.jobs.sent.map((envelope) => envelope.payload["turnId"]).sort(),
    ).toEqual([...committedTurnIds].sort());
    committedRunsDone.fire();
    const failed = await Promise.allSettled(failing);

    expect(committed.map((outcome) => outcome.status)).toEqual(
      committedTurnIds.map(() => "fulfilled"),
    );
    expect(failed.map((outcome) => outcome.status)).toEqual(
      committedTurnIds.map(() => "rejected"),
    );
    expect(
      kit.jobs.sent.map((envelope) => envelope.payload["turnId"]).sort(),
    ).toEqual([...committedTurnIds].sort());
  });

  it("hands the port the execution transaction the runner opened, while it is open", async () => {
    const openTransactions = new Set<Tx>();
    const runner: ActionTransactionRunner = {
      transaction: (run, config) =>
        kit.db.runtime.db.transaction(async (tx) => {
          openTransactions.add(tx);
          try {
            return await run(tx);
          } finally {
            openTransactions.delete(tx);
          }
        }, config),
    };
    const sends: {
      readonly onOpenRunnerTx: boolean;
      readonly count: number;
    }[] = [];
    const port: JobPort = {
      enqueue(tx, envelopes) {
        sends.push({
          onOpenRunnerTx: openTransactions.has(tx),
          count: envelopes.length,
        });
        return Promise.resolve();
      },
    };

    await kit.invoke(
      noteAction,
      { turnId: randomUUID() },
      {},
      {
        deps: {
          ...kit.pipeline,
          db: runner,
          hooks: { ...kit.pipeline.hooks, jobs: port },
        },
      },
    );

    expect(sends).toEqual([{ onOpenRunnerTx: true, count: 1 }]);
  });

  it("wraps only a whole-database runner, never an open transaction", () => {
    type CommitBoundSource = Parameters<TestKit["jobs"]["commitBound"]>[0];
    type TxIsAccepted = Tx extends CommitBoundSource ? true : false;
    expectTypeOf<TxIsAccepted>().toEqualTypeOf<false>();
  });

  it("refuses a send outside a commit-bound transaction", async () => {
    const envelope = buildJobEnvelope(runTurn, {
      companyId: kit.identities.companies.a,
      payload: { turnId: randomUUID() },
    });

    await expect(
      kit.db.runtime.db.transaction((tx) => kit.jobs.enqueue(tx, [envelope])),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("fails closed when an action declaring enqueues has no job port", async () => {
    const hooks = { ...kit.pipeline.hooks, jobs: undefined };

    await expectRefused(
      kit.invoke(
        noteAction,
        { turnId: randomUUID() },
        {},
        { deps: { ...kit.pipeline, hooks } },
      ),
      "no job port is composed",
    );
  });
});

describe("job identity (J2)", () => {
  it("never reuses a client request id as the origin of two executions", async () => {
    const turnId = randomUUID();
    const requestId = randomUUID();

    await kit.invoke(noteAction, { turnId }, {}, { request: { requestId } });
    await kit.invoke(noteAction, { turnId }, {}, { request: { requestId } });

    const [first, second] = kit.jobs.sent;
    expect(first?.executionId).not.toBe(second?.executionId);
    expect(first?.id).not.toBe(second?.id);
  });

  it("never collides across tenants sharing an idempotency key", async () => {
    const turnId = randomUUID();
    const request = { idempotencyKey: `turn-${turnId}` };

    await kit.invoke(
      acceptAction,
      { turnId },
      { companyId: kit.identities.companies.a },
      { request },
    );
    await kit.invoke(
      acceptAction,
      { turnId },
      { companyId: kit.identities.companies.b },
      { request },
    );

    const [inA, inB] = kit.jobs.sent;
    expect(inA?.companyId).toBe(kit.identities.companies.a);
    expect(inB?.companyId).toBe(kit.identities.companies.b);
    expect(inA?.id).not.toBe(inB?.id);
  });

  it("fans a job out only by its discriminator", async () => {
    await kit.invoke(noteAction, {
      turnId: randomUUID(),
      reminderIds: [randomUUID(), randomUUID()],
    });

    const reminders = kit.jobs.sent.filter(
      (envelope) => envelope.name === "jobKit.sendReminder",
    );
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.id).not.toBe(reminders[1]?.id);
  });

  it("throws on fan-out without a discriminator", async () => {
    await expectRefused(
      kit.invoke(noteAction, {
        turnId: randomUUID(),
        mode: "fanOutWithoutDiscriminator",
      }),
      "requires a discriminator",
    );
    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("throws on two sends with one id in one transaction", async () => {
    await expectRefused(
      kit.invoke(noteAction, {
        turnId: randomUUID(),
        mode: "sameDiscriminator",
      }),
      "two sends with one job id",
    );
    expect(kit.jobs.sent).toHaveLength(0);
  });
});

describe("replays and deliveries (J3)", () => {
  it("enqueues nothing on an idempotency replay", async () => {
    const turnId = randomUUID();
    const request = { idempotencyKey: `turn-${turnId}` };
    const runsBefore = acceptRuns;

    await kit.invoke(acceptAction, { turnId }, {}, { request });
    await kit.invoke(acceptAction, { turnId }, {}, { request });

    expect(acceptRuns - runsBefore).toBe(1);
    expect(kit.jobs.sent).toHaveLength(1);
  });

  it("commits a delivery's jobs with its processed mark, once", async () => {
    const turnId = randomUUID();
    const eventId = await emitNoted(turnId);
    const options = {
      subscription: startTurnSubscription,
      eventId,
      claimedBy: "jobs-test",
    };

    const first = await executeDelivery(kit.pipeline, options);
    const again = await executeDelivery(kit.pipeline, options);

    expect(first.status).toBe("processed");
    expect(again.status).toBe("alreadyProcessed");
    expect(kit.jobs.sent).toEqual([
      expect.objectContaining({
        name: "jobKitWorker.runTurn",
        companyId: kit.identities.companies.a,
        actor: { type: "system", id: "jobKitWorker.turn-starter" },
        payload: { turnId },
      }),
    ]);
  });

  it("sends nothing when the delivery rolls back", async () => {
    const turnId = randomUUID();
    failStartFor.add(turnId);
    const eventId = await emitNoted(turnId);

    const outcome = await executeDelivery(kit.pipeline, {
      subscription: startTurnSubscription,
      eventId,
      claimedBy: "jobs-test",
    });

    expect(outcome.status).toBe("failed");
    expect(kit.jobs.sent).toHaveLength(0);
    const rows = await kit.db.runtime.db
      .select({ status: eventDeliveries.status })
      .from(eventDeliveries)
      .where(eq(eventDeliveries.eventId, eventId));
    expect(rows).toEqual([{ status: "pending" }]);
  });
});

describe("only the root writable action enqueues (J4)", () => {
  it("refuses an undeclared job", async () => {
    await expectRefused(
      kit.invoke(noteAction, { turnId: randomUUID(), mode: "undeclared" }),
      'undeclared job "jobKit.undeclared"',
    );
  });

  it("refuses a read action", async () => {
    await expectRefused(
      kit.invoke(peekAction, { turnId: randomUUID() }),
      "read action",
    );
  });

  it("refuses a ctx.call callee", async () => {
    await expectRefused(
      kit.invoke(lookupAction, { turnId: randomUUID() }),
      'nested callee "jobKitCallee.peek"',
    );
    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("refuses a ctx.callAtomic callee", async () => {
    await expectRefused(
      kit.invoke(reserveAction, { turnId: randomUUID() }),
      'nested callee "jobKitCallee.hold"',
    );
    expect(kit.jobs.sent).toHaveLength(0);
  });
});
