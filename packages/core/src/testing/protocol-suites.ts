/**
 * Inherited protocol suites every module instantiates (fnd-T22 — core.md §12).
 *
 * Isolation suites live in `suites.ts`. These cover idempotency, events,
 * atomic calls, and the social desired-state helper that modules with
 * follow/like writes copy.
 *
 * Each registrar adds vitest `it` blocks that call `getKit()` lazily so
 * `beforeAll` can seed first. The `run*` functions are the same
 * assertions without registration, so the kit self-tests can prove a
 * seeded violation fails them. `runSocialDesiredStateCase` is a `run*`
 * helper only (core.md §12) — not a `suiteCoverage` registrar.
 */
import { randomUUID } from "node:crypto";

import { domainEvents } from "@showzy/db";
import { eq } from "drizzle-orm";
import { describe, it } from "vitest";

import {
  ConcurrentRetryError,
  ConfirmationRequiredError,
  CoreInvariantError,
  IdempotencyConflictError,
} from "../errors/index.js";
import {
  dispatchOutboxBatch,
  executeDelivery,
} from "../runtime/events/delivery.js";
import type { EventSubscription } from "../runtime/events/define-event-handler.js";
import type { PipelineRequestMeta } from "../runtime/pipeline/types.js";
import { challengeIdFor, invokeConfirmedAction } from "./confirmation-gate.js";
import { invokeAction, type IsolationActor, type TestKit } from "./kit.js";
import type { SuiteAction } from "./suites.js";

export interface IdempotencyCase {
  readonly action: SuiteAction;
  readonly input: unknown;
  readonly conflictingInput: unknown;
  readonly actor?: IsolationActor;
  /** Observable side-effect count (row count, counter, …). */
  readonly readEffect: (kit: TestKit) => Promise<number>;
  /**
   * Fresh input for the concurrent double-submit. Required when `input`
   * is not safely replayable under a new key (unique side-effect ids).
   */
  readonly freshInput?: () => unknown;
}

export interface EventSuiteSpec {
  readonly module: string;
  readonly emitAction: SuiteAction;
  readonly emitInput: unknown;
  readonly failingEmitAction: SuiteAction;
  readonly failingEmitInput: unknown;
  readonly actor?: IsolationActor;
  readonly eventName: string;
  readonly subscription: EventSubscription;
  readonly readProjection: (kit: TestKit) => Promise<number>;
}

export interface AtomicCallProbe {
  readonly action: SuiteAction;
  readonly input: unknown;
  readonly actor?: IsolationActor;
}

export interface AtomicCallCase {
  readonly root: SuiteAction;
  readonly successInput: unknown;
  readonly failureInput: unknown;
  readonly actor?: IsolationActor;
  readonly readRootEffect: (kit: TestKit) => Promise<number>;
  readonly readCalleeEffect: (kit: TestKit) => Promise<number>;
  /** Root whose handler calls an undeclared atomic callee. */
  readonly undeclared: AtomicCallProbe;
  /** Mutually declared edge with a principal or tenant mismatch. */
  readonly mismatch: AtomicCallProbe;
  /** Declared edge whose callee nests another atomic call. */
  readonly nested: AtomicCallProbe;
}

export interface SocialDesiredStateCase {
  readonly action: SuiteAction;
  readonly desiredInput: unknown;
  readonly oppositeInput: unknown;
  readonly actor?: IsolationActor;
  readonly readCount: (kit: TestKit) => Promise<number>;
}

const DISPATCHER = "test-kit-dispatcher";
const WORKER = "test-kit-worker";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function invokeThroughGate(
  kit: TestKit,
  action: SuiteAction,
  input: unknown,
  actor: IsolationActor | undefined,
  request: Partial<PipelineRequestMeta>,
): Promise<unknown> {
  if (!action.contract.requiresConfirmation) {
    return await invokeAction(kit, action, input, actor, { request });
  }
  return await invokeConfirmedAction(kit, action, input, actor, { request });
}

async function replayWithoutChallenge(
  kit: TestKit,
  c: IdempotencyCase,
  key: string,
): Promise<unknown> {
  try {
    return await invokeAction(kit, c.action, c.input, c.actor, {
      request: { idempotencyKey: key },
    });
  } catch (error) {
    if (error instanceof ConfirmationRequiredError) {
      throw new Error(
        `"${c.action.contract.name}" issued a new confirmation card for a completed key instead of replaying it (core.md §5)`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runIdempotencyCase(
  kit: TestKit,
  c: IdempotencyCase,
): Promise<void> {
  const key = randomUUID();
  const before = await c.readEffect(kit);
  const first = await invokeThroughGate(kit, c.action, c.input, c.actor, {
    idempotencyKey: key,
  });
  const afterFirst = await c.readEffect(kit);
  const replay = await replayWithoutChallenge(kit, c, key);
  const afterReplay = await c.readEffect(kit);
  if (!sameJson(first, replay)) {
    throw new Error(
      `"${c.action.contract.name}" replay returned a different output`,
    );
  }
  if (afterReplay !== afterFirst) {
    throw new Error(
      `"${c.action.contract.name}" replay re-ran the handler (${String(afterFirst)} → ${String(afterReplay)})`,
    );
  }
  if (afterFirst < before) {
    throw new Error(
      `"${c.action.contract.name}" first run decreased the tracked effect`,
    );
  }

  try {
    await invokeAction(kit, c.action, c.conflictingInput, c.actor, {
      request: { idempotencyKey: key },
    });
  } catch (error) {
    if (!(error instanceof IdempotencyConflictError)) {
      throw error;
    }
    await runConcurrentIdempotency(kit, c);
    return;
  }
  throw new Error(
    `"${c.action.contract.name}" accepted the same key with a different payload`,
  );
}

async function concurrentRequests(
  kit: TestKit,
  c: IdempotencyCase,
  input: unknown,
  key: string,
): Promise<readonly Partial<PipelineRequestMeta>[]> {
  const base = { idempotencyKey: key };
  if (!c.action.contract.requiresConfirmation) {
    return [base, base];
  }
  const name = c.action.contract.name;
  const first = await challengeIdFor(
    name,
    invokeAction(kit, c.action, input, c.actor, { request: base }),
  );
  const second = await challengeIdFor(
    name,
    invokeAction(kit, c.action, input, c.actor, { request: base }),
  );
  return [first, second].map((confirmationChallengeId) => ({
    ...base,
    confirmationChallengeId,
  }));
}

async function runConcurrentIdempotency(
  kit: TestKit,
  c: IdempotencyCase,
): Promise<void> {
  const key = randomUUID();
  const input = c.freshInput?.() ?? c.input;
  const requests = await concurrentRequests(kit, c, input, key);
  const before = await c.readEffect(kit);
  const results = await Promise.allSettled(
    requests.map((request) =>
      invokeAction(kit, c.action, input, c.actor, { request }),
    ),
  );
  const fulfilled: PromiseFulfilledResult<unknown>[] = [];
  const rejected: PromiseRejectedResult[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      fulfilled.push(result);
    } else {
      rejected.push(result);
    }
  }
  if (fulfilled.length === 0) {
    const first = rejected[0];
    throw first !== undefined
      ? first.reason
      : new Error(`"${c.action.contract.name}" concurrent submits both failed`);
  }
  const first = fulfilled[0];
  const second = fulfilled[1];
  if (first !== undefined && second !== undefined) {
    if (!sameJson(first.value, second.value)) {
      throw new Error(
        `"${c.action.contract.name}" concurrent submits produced different outputs`,
      );
    }
  } else {
    for (const result of rejected) {
      if (!(result.reason instanceof ConcurrentRetryError)) {
        throw result.reason;
      }
    }
  }
  const after = await c.readEffect(kit);
  if (after - before > 1) {
    throw new Error(
      `"${c.action.contract.name}" concurrent double-submit ran the handler more than once`,
    );
  }
}

export function idempotencySuite(
  getKit: () => TestKit,
  cases: readonly IdempotencyCase[],
): void {
  describe("idempotencySuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} replays, conflicts, and concurrent-retries`, async () => {
        await runIdempotencyCase(getKit(), c);
      });
    }
  });
}

export async function runEventSuiteCase(
  kit: TestKit,
  spec: EventSuiteSpec,
): Promise<void> {
  await assertTransactionalEmit(kit, spec);
  await assertConsumerDedup(kit, spec);
}

async function assertTransactionalEmit(
  kit: TestKit,
  spec: EventSuiteSpec,
): Promise<void> {
  const requestId = randomUUID();
  try {
    await invokeThroughGate(
      kit,
      spec.failingEmitAction,
      spec.failingEmitInput,
      spec.actor,
      { requestId, idempotencyKey: randomUUID() },
    );
  } catch {
    const leftover = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    if (leftover.length > 0) {
      throw new Error(
        `"${spec.failingEmitAction.contract.name}" rolled back the handler but left outbox rows`,
      );
    }
    return;
  }
  throw new Error(
    `"${spec.failingEmitAction.contract.name}" was expected to fail after emit`,
  );
}

async function assertConsumerDedup(
  kit: TestKit,
  spec: EventSuiteSpec,
): Promise<void> {
  const requestId = randomUUID();
  const before = await spec.readProjection(kit);
  await invokeThroughGate(kit, spec.emitAction, spec.emitInput, spec.actor, {
    requestId,
    idempotencyKey: randomUUID(),
  });
  const eventRows = await kit.db.runtime.db
    .select({ id: domainEvents.id, name: domainEvents.name })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  const match = eventRows.filter((row) => row.name === spec.eventName);
  if (match.length !== 1 || match[0] === undefined) {
    throw new Error(
      `"${spec.emitAction.contract.name}" did not emit exactly one "${spec.eventName}" outbox row`,
    );
  }
  const eventId = match[0].id;
  await dispatchOutboxBatch(
    { db: kit.db.runtime.db },
    { subscriptions: [spec.subscription], claimedBy: DISPATCHER },
  );
  await driveToProcessed(kit, spec.subscription, eventId);
  const afterFirst = await spec.readProjection(kit);
  if (afterFirst !== before + 1) {
    throw new Error(
      `"${spec.subscription.consumer}" projection moved ${String(before)} → ${String(afterFirst)}, expected ${String(before + 1)}`,
    );
  }
  const redelivery = await executeDelivery(kit.pipeline, {
    subscription: spec.subscription,
    eventId,
    claimedBy: WORKER,
  });
  if (
    redelivery.status !== "alreadyProcessed" &&
    redelivery.status !== "processed"
  ) {
    throw new Error(
      `"${spec.subscription.consumer}" redelivery status was ${redelivery.status}`,
    );
  }
  const afterReplay = await spec.readProjection(kit);
  if (afterReplay !== afterFirst) {
    throw new Error(
      `"${spec.subscription.consumer}" redelivery applied effects again (${String(afterFirst)} → ${String(afterReplay)})`,
    );
  }
}

async function driveToProcessed(
  kit: TestKit,
  subscription: EventSubscription,
  eventId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await executeDelivery(kit.pipeline, {
      subscription,
      eventId,
      claimedBy: WORKER,
    });
    if (
      outcome.status === "processed" ||
      outcome.status === "alreadyProcessed"
    ) {
      return;
    }
    if (outcome.status === "failed") {
      throw outcome.error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`delivery of ${eventId} did not reach processed`);
}

export function eventSuite(getKit: () => TestKit, spec: EventSuiteSpec): void {
  describe(`eventSuite (${spec.module})`, () => {
    it("emits transactionally and respects consumer dedup", async () => {
      await runEventSuiteCase(getKit(), spec);
    });
  });
}

async function domainEventCount(kit: TestKit): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents);
  return rows.length;
}

async function invokeProbe(
  kit: TestKit,
  probe: AtomicCallProbe,
  fallbackActor: IsolationActor | undefined,
  detail: string,
): Promise<void> {
  await expectCoreInvariant(
    () =>
      invokeAction(
        kit,
        probe.action,
        probe.input,
        probe.actor ?? fallbackActor,
        { request: { idempotencyKey: randomUUID() } },
      ),
    probe.action.contract.name,
    detail,
  );
}

export async function runAtomicCallCase(
  kit: TestKit,
  c: AtomicCallCase,
): Promise<void> {
  const rootBefore = await c.readRootEffect(kit);
  const calleeBefore = await c.readCalleeEffect(kit);
  const eventsBefore = await domainEventCount(kit);
  try {
    await invokeAction(kit, c.root, c.failureInput, c.actor, {
      request: { idempotencyKey: randomUUID() },
    });
  } catch {
    const rootAfterFail = await c.readRootEffect(kit);
    const calleeAfterFail = await c.readCalleeEffect(kit);
    if (rootAfterFail !== rootBefore || calleeAfterFail !== calleeBefore) {
      throw new Error(
        `"${c.root.contract.name}" rollback left root ${String(rootBefore)}→${String(rootAfterFail)} callee ${String(calleeBefore)}→${String(calleeAfterFail)}`,
      );
    }
    const eventsAfterFail = await domainEventCount(kit);
    if (eventsAfterFail !== eventsBefore) {
      throw new Error(
        `"${c.root.contract.name}" rollback left domain_events rows (${String(eventsBefore)} → ${String(eventsAfterFail)})`,
      );
    }
    const committed = await invokeAction(kit, c.root, c.successInput, c.actor, {
      request: { idempotencyKey: randomUUID() },
    });
    void committed;
    const rootAfter = await c.readRootEffect(kit);
    const calleeAfter = await c.readCalleeEffect(kit);
    if (rootAfter === rootBefore) {
      throw new Error(
        `"${c.root.contract.name}" commit did not persist the root effect`,
      );
    }
    if (calleeAfter === calleeBefore) {
      throw new Error(
        `"${c.root.contract.name}" commit did not persist the callee effect`,
      );
    }
    await invokeProbe(kit, c.undeclared, c.actor, "undeclared edge");
    await invokeProbe(kit, c.mismatch, c.actor, "principal/tenant mismatch");
    await invokeProbe(kit, c.nested, c.actor, "nested atomic call");
    return;
  }
  throw new Error(
    `"${c.root.contract.name}" failure input was expected to roll back`,
  );
}

export function atomicCallSuite(
  getKit: () => TestKit,
  cases: readonly AtomicCallCase[],
): void {
  describe("atomicCallSuite", () => {
    for (const c of cases) {
      it(`${c.root.contract.name} commits atomically, rolls back events, and rejects illegal edges`, async () => {
        await runAtomicCallCase(getKit(), c);
      });
    }
  });
}

export async function runSocialDesiredStateCase(
  kit: TestKit,
  c: SocialDesiredStateCase,
): Promise<void> {
  const deps = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      rateLimit: { enforce: () => Promise.resolve() },
    },
  };
  await invokeAction(kit, c.action, c.desiredInput, c.actor, {
    deps,
    request: { idempotencyKey: randomUUID() },
  });
  const afterSet = await c.readCount(kit);
  await invokeAction(kit, c.action, c.desiredInput, c.actor, {
    deps,
    request: { idempotencyKey: randomUUID() },
  });
  const afterRetry = await c.readCount(kit);
  if (afterRetry !== afterSet) {
    throw new Error(
      `"${c.action.contract.name}" retry of the same desired state changed the counter (${String(afterSet)} → ${String(afterRetry)})`,
    );
  }
  await Promise.all([
    invokeAction(kit, c.action, c.desiredInput, c.actor, {
      deps,
      request: { idempotencyKey: randomUUID() },
    }),
    invokeAction(kit, c.action, c.desiredInput, c.actor, {
      deps,
      request: { idempotencyKey: randomUUID() },
    }),
  ]);
  const afterRace = await c.readCount(kit);
  if (afterRace !== afterSet) {
    throw new Error(
      `"${c.action.contract.name}" concurrent same-state writes changed the counter (${String(afterSet)} → ${String(afterRace)})`,
    );
  }
  await invokeAction(kit, c.action, c.oppositeInput, c.actor, {
    deps,
    request: { idempotencyKey: randomUUID() },
  });
  const afterOpposite = await c.readCount(kit);
  if (afterOpposite === afterSet) {
    throw new Error(
      `"${c.action.contract.name}" opposite state did not change the counter`,
    );
  }
  await invokeAction(kit, c.action, c.desiredInput, c.actor, {
    deps,
    request: { idempotencyKey: randomUUID() },
  });
  const restored = await c.readCount(kit);
  if (restored !== afterSet) {
    throw new Error(
      `"${c.action.contract.name}" restoring the desired state left the counter at ${String(restored)}`,
    );
  }
}

export async function expectCoreInvariant(
  run: () => Promise<unknown>,
  actionName: string,
  detail: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CoreInvariantError) {
      return;
    }
    throw error;
  }
  throw new Error(`expected "${actionName}" to fail (${detail})`);
}
