/**
 * Integration tests for the confirmation protocol (fnd-T20 — core.md §7)
 * against the shared Testcontainers harness.
 *
 * Verifies:
 * - Execution without a valid challenge is impossible.
 * - Completed replay bypasses the single-use challenge.
 * - A consumed grant is persisted on the idempotency reservation.
 * - A failed/stale attempt resumes under that unexpired grant without
 *   reusing the raw token.
 * - An expired grant requires a new challenge.
 * - Concurrent confirm runs the handler exactly once.
 * - Redis-down fails closed.
 * - `confirmationSummary` sees the preflight-resolved target.
 */
import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  companyMembers,
  idempotencyKeys,
  rolePermissionDefaults,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureCrmCustomers,
  parityIds,
  seedParityFixtures,
} from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConfirmationRequiredError,
  ConcurrentRetryError,
  ConflictError,
  CoreInvariantError,
  ValidationError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import {
  createIdempotencyHook,
  IDEMPOTENCY_LEASE_MARGIN_MS,
} from "../idempotency/create-idempotency-hook.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineRequestMeta,
  RateLimitHook,
} from "../pipeline/types.js";
import type { ConfirmationSummaryEnv, ResolvedTarget } from "../types.js";
import {
  CONFIRMATION_TTL_MS,
  createConfirmationHook,
} from "./create-confirmation-hook.js";
import {
  createInMemoryConfirmationStore,
  type ConfirmationStore,
} from "./store.js";

let database: TestDatabase;

const users = {
  anna: "user_anna_confirm_db",
  boris: "user_boris_confirm_db",
} as const;
const companyA = randomUUID();

const silentLogger = pino({ enabled: false });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db.insert(user).values([
    { id: users.anna, name: "Anna", email: "anna-confirm@example.test" },
    { id: users.boris, name: "Boris", email: "boris-confirm@example.test" },
  ]);
  await database.runtime.db
    .insert(companies)
    .values([
      { id: companyA, name: "Confirm Co", slug: "confirm-co", prefix: "CF" },
    ]);
  await database.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "owner", permission: "confirmFixture:manage" }]);
  await database.runtime.db.insert(companyMembers).values(
    Object.values(users).map((userId) => ({
      companyId: companyA,
      userId,
      role: "owner" as const,
      permissions: { granted: [], denied: [] },
    })),
  );
  await createParityFixtureTables(database.admin);
  await seedParityFixtures(database.runtime.db);
});

afterAll(async () => {
  await database.close();
});

const contract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  name: "confirmFixture.revokeAccess",
  description: "Idempotent high-risk confirmation fixture.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["confirmFixture:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

type FixtureAction = ImplementedAction<
  typeof contract.input,
  typeof contract.output
>;

function countingAction(): { action: FixtureAction; runs: () => number } {
  let runs = 0;
  const action = implementAction(contract, {
    handler: () => {
      runs += 1;
      return Promise.resolve({ resultId: randomUUID() });
    },
    confirmationSummary: () => "Revoke access for Confirm Co.",
    auditTarget: () => ({ type: "note", id: "fixture" }),
  });
  return { action, runs: () => runs };
}

function fakeClock(startMs = Date.now()): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function arrivalBarrier(expected: number): {
  readonly arrive: () => Promise<void>;
  readonly waitUntilFull: Promise<void>;
  readonly release: () => void;
} {
  let arrivals = 0;
  const full = deferred();
  const released = deferred();
  return {
    arrive: async () => {
      arrivals += 1;
      if (arrivals === expected) {
        full.resolve();
      }
      await released.promise;
    },
    waitUntilFull: full.promise,
    release: released.resolve,
  };
}

function deps(
  options: {
    readonly store?: ConfirmationStore;
    readonly now?: () => number;
    readonly confirmation?: boolean;
    readonly beforeTakeover?: () => Promise<void>;
  } = {},
): ActionPipelineDeps {
  const clock = options.now === undefined ? {} : { now: options.now };
  const store = options.store ?? createInMemoryConfirmationStore(clock);
  const rateLimit: RateLimitHook = { enforce: () => Promise.resolve() };
  return {
    db: database.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit,
      audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
      idempotency: createIdempotencyHook({
        db: database.runtime.db,
        ...clock,
        ...(options.beforeTakeover === undefined
          ? {}
          : { beforeTakeover: options.beforeTakeover }),
      }),
      ...(options.confirmation === false
        ? {}
        : {
            confirmation: createConfirmationHook({ store, ...clock }),
          }),
    },
  };
}

function requestMeta(
  overrides: Partial<PipelineRequestMeta> = {},
): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    ...overrides,
  };
}

interface RunOptions {
  readonly key?: string;
  readonly userId?: string;
  readonly note?: string;
  readonly challengeId?: string;
  readonly requestId?: string;
  readonly store?: ConfirmationStore;
  readonly now?: () => number;
  readonly confirmation?: boolean;
  readonly beforeTakeover?: () => Promise<void>;
  readonly action?: FixtureAction;
}

/**
 * One store per logical submit — issue and consume must see the same
 * challenges. `now` is shared with the hooks so expiry tests stay coherent.
 */
function session(
  options: {
    readonly now?: () => number;
    readonly store?: ConfirmationStore;
  } = {},
): {
  readonly store: ConfirmationStore;
  run(options?: RunOptions): Promise<{ resultId: string }>;
  requireChallenge(options?: RunOptions): Promise<ConfirmationRequiredError>;
} {
  const clock = options.now === undefined ? {} : { now: options.now };
  const store = options.store ?? createInMemoryConfirmationStore(clock);
  return {
    store,
    run: (runOptions = {}) => run({ ...runOptions, store, ...clock }),
    requireChallenge: (runOptions = {}) =>
      requireChallenge({
        ...runOptions,
        store,
        ...clock,
      }),
  };
}

function run(options: RunOptions = {}): Promise<{ resultId: string }> {
  const { action } =
    options.action !== undefined
      ? { action: options.action }
      : countingAction();
  return executeAction(deps(options), {
    action,
    input: { note: options.note ?? "hello" },
    request: requestMeta({
      ...(options.requestId !== undefined
        ? { requestId: options.requestId }
        : {}),
      ...(options.key !== undefined ? { idempotencyKey: options.key } : {}),
      ...(options.challengeId !== undefined
        ? { confirmationChallengeId: options.challengeId }
        : {}),
    }),
    principal: {
      mode: "staff",
      session: { userId: options.userId ?? users.anna },
      companySelector: companyA,
    },
  });
}

async function requireChallenge(
  options: RunOptions = {},
): Promise<ConfirmationRequiredError> {
  const error = await run(options).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConfirmationRequiredError);
  return error as ConfirmationRequiredError;
}

async function rowsForKey(
  key: string,
): Promise<(typeof idempotencyKeys.$inferSelect)[]> {
  return database.runtime.db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.action, contract.name),
        eq(idempotencyKeys.key, key),
      ),
    );
}

describe("confirmation protocol — challenge required (core.md §7)", () => {
  it("cannot execute without a challenge", async () => {
    const { action, runs } = countingAction();
    const key = randomUUID();
    const flow = session();

    const required = await flow.requireChallenge({ action, key });

    expect(required.challenge.summary).toBe("Revoke access for Confirm Co.");
    expect(runs()).toBe(0);
    expect(await rowsForKey(key)).toHaveLength(0);
  });

  it("executes after a matching challenge is consumed", async () => {
    const { action, runs } = countingAction();
    const key = randomUUID();
    const flow = session();
    const required = await flow.requireChallenge({ action, key });

    const result = await flow.run({
      action,
      key,
      challengeId: required.challenge.challengeId,
    });

    expect(result.resultId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(runs()).toBe(1);
  });

  it("rejects a missing idempotency key before issuing a challenge", async () => {
    const { action, runs } = countingAction();

    await expect(run({ action })).rejects.toThrow(ValidationError);
    expect(runs()).toBe(0);
  });

  it("fails closed when no confirmation hook is composed", async () => {
    const { action, runs } = countingAction();

    await expect(
      run({ action, key: randomUUID(), confirmation: false }),
    ).rejects.toThrow(CoreInvariantError);
    expect(runs()).toBe(0);
  });
});

describe("confirmation protocol — replay and persisted grant", () => {
  it("replays a completed result without a challenge token", async () => {
    const { action, runs } = countingAction();
    const key = randomUUID();
    const flow = session();
    const required = await flow.requireChallenge({ action, key });
    const first = await flow.run({
      action,
      key,
      challengeId: required.challenge.challengeId,
    });

    const replayed = await flow.run({ action, key });

    expect(replayed.resultId).toBe(first.resultId);
    expect(runs()).toBe(1);
  });

  it("persists the consumed grant on the idempotency reservation", async () => {
    const { action } = countingAction();
    const key = randomUUID();
    const flow = session();
    const required = await flow.requireChallenge({ action, key });
    await flow.run({
      action,
      key,
      challengeId: required.challenge.challengeId,
    });

    const [row] = await rowsForKey(key);
    expect(row?.status).toBe("completed");
    expect(row?.confirmationChallengeId).toBe(required.challenge.challengeId);
    expect(row?.confirmedAt).toBeInstanceOf(Date);
    expect(row?.confirmationExpiresAt?.toISOString()).toBe(
      required.challenge.expiresAt,
    );
  });

  it("resumes a failed attempt under the persisted unexpired grant", async () => {
    let failFirst = true;
    let runs = 0;
    const action = implementAction(contract, {
      handler: () => {
        runs += 1;
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new ConflictError("First attempt fails."));
        }
        return Promise.resolve({ resultId: randomUUID() });
      },
      confirmationSummary: () => "Revoke access for Confirm Co.",
      auditTarget: () => ({ type: "note", id: "fixture" }),
    });
    const key = randomUUID();
    const flow = session();
    const required = await flow.requireChallenge({ action, key });
    await expect(
      flow.run({ action, key, challengeId: required.challenge.challengeId }),
    ).rejects.toThrow(ConflictError);

    const [failed] = await rowsForKey(key);
    expect(failed?.status).toBe("failed");
    expect(failed?.confirmationChallengeId).toBe(
      required.challenge.challengeId,
    );

    // No raw token — the persisted grant is the resume proof (§5).
    const retried = await flow.run({ action, key });
    expect(runs).toBe(2);
    expect(retried.resultId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("requires a new challenge when the persisted grant has expired", async () => {
    const clock = fakeClock();
    let failFirst = true;
    const action = implementAction(contract, {
      handler: () => {
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new ConflictError("First attempt fails."));
        }
        return Promise.resolve({ resultId: randomUUID() });
      },
      confirmationSummary: () => "Revoke access for Confirm Co.",
      auditTarget: () => ({ type: "note", id: "fixture" }),
    });
    const key = randomUUID();
    const flow = session({ now: clock.now });
    const required = await flow.requireChallenge({ action, key });
    await expect(
      flow.run({
        action,
        key,
        challengeId: required.challenge.challengeId,
      }),
    ).rejects.toThrow(ConflictError);

    clock.advance(CONFIRMATION_TTL_MS + 1);
    const retry = await flow.requireChallenge({ action, key });

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("replays a confirmed completion instead of reclaiming it, without a new challenge or second audit", async () => {
    const clock = fakeClock();
    const originalStarted = deferred();
    const originalHold = deferred();
    const takeover = arrivalBarrier(1);
    const originalRequestId = randomUUID();
    const reclaimerRequestId = randomUUID();
    let runs = 0;
    const action = implementAction(contract, {
      handler: async () => {
        originalStarted.resolve();
        await originalHold.promise;
        runs += 1;
        return { resultId: randomUUID() };
      },
      confirmationSummary: () => "Revoke access for Confirm Co.",
      auditTarget: () => ({ type: "note", id: "fixture" }),
    });
    const key = randomUUID();
    const flow = session({ now: clock.now });
    const required = await flow.requireChallenge({ action, key });
    const original = flow.run({
      action,
      key,
      challengeId: required.challenge.challengeId,
      requestId: originalRequestId,
      beforeTakeover: takeover.arrive,
    });
    await originalStarted.promise;
    clock.advance(contract.timeout + IDEMPOTENCY_LEASE_MARGIN_MS + 1);

    const reclaimer = flow.run({
      action,
      key,
      requestId: reclaimerRequestId,
      beforeTakeover: takeover.arrive,
    });
    await takeover.waitUntilFull;
    originalHold.resolve();
    const first = await original;
    takeover.release();
    const replayed = await reclaimer;

    expect(replayed.resultId).toBe(first.resultId);
    expect(runs).toBe(1);
    const [row] = await rowsForKey(key);
    expect(row?.status).toBe("completed");
    expect(row?.confirmationChallengeId).toBe(required.challenge.challengeId);
    expect(row?.response).toEqual({ resultId: first.resultId });

    const originalAudit = await database.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, originalRequestId));
    const reclaimerAudit = await database.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, reclaimerRequestId));
    expect(originalAudit).toHaveLength(1);
    expect(originalAudit[0]?.outcome).toBe("ok");
    expect(reclaimerAudit).toHaveLength(0);
  });
});

describe("confirmation protocol — concurrency and fail-closed", () => {
  it("runs the handler exactly once on a concurrent confirm", async () => {
    let releaseHandler = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let signalStarted = (): void => {};
    const handlerStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let runs = 0;
    const action = implementAction(contract, {
      handler: async () => {
        signalStarted();
        await gate;
        runs += 1;
        return { resultId: randomUUID() };
      },
      confirmationSummary: () => "Revoke access for Confirm Co.",
      auditTarget: () => ({ type: "note", id: "fixture" }),
    });
    const key = randomUUID();
    const flow = session();
    const required = await flow.requireChallenge({ action, key });

    const winner = flow.run({
      action,
      key,
      challengeId: required.challenge.challengeId,
    });
    await handlerStarted;
    const loser = await flow
      .run({
        action,
        key,
        challengeId: required.challenge.challengeId,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    releaseHandler();
    await winner;

    // The first confirm reserved a live lease; the probe returns
    // ConcurrentRetryError before the already-consumed token is touched.
    expect(loser).toBeInstanceOf(ConcurrentRetryError);
    expect(runs).toBe(1);
  });

  it("fails closed when the confirmation store is down", async () => {
    const { action, runs } = countingAction();
    const failingStore: ConfirmationStore = {
      set() {
        return Promise.reject(new Error("redis connection refused"));
      },
      getAndDelete() {
        return Promise.reject(new Error("redis connection refused"));
      },
    };

    await expect(
      run({ action, key: randomUUID(), store: failingStore }),
    ).rejects.toThrow(CoreInvariantError);
    expect(runs()).toBe(0);
  });
});

describe("confirmation protocol — summary environment", () => {
  it("passes the preflight-resolved target to confirmationSummary", async () => {
    const customerContract = defineActionContract({
      transport: "client",
      aiExposure: "internal",
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      name: "confirmFixture.customerRevoke",
      description: "Customer confirmation fixture.",
      principal: "customer",
      input: z.object({ customerId: z.uuid() }),
      output: z.object({ companyId: z.uuid() }),
      permissions: [],
      risk: "high",
      requiresConfirmation: true,
      idempotent: true,
      audit: true,
      timeout: 5_000,
    });
    let seen: ConfirmationSummaryEnv | undefined;
    const action = implementAction(customerContract, {
      handler: (_input, ctx) => {
        return Promise.resolve({ companyId: ctx.target.companyId });
      },
      resolveTarget: async (input, resolveEnv) => {
        if (resolveEnv.principal.mode !== "customer") {
          throw new CoreInvariantError("fixture expects a customer resolver");
        }
        const rows = await resolveEnv.tx
          .select()
          .from(fixtureCrmCustomers)
          .where(eq(fixtureCrmCustomers.id, input.customerId))
          .limit(1);
        const row = rows[0];
        if (row === undefined || row.userId !== resolveEnv.principal.userId) {
          throw new CoreInvariantError("seeded CRM customer missing");
        }
        return {
          companyId: row.companyId,
          resource: row,
        } satisfies ResolvedTarget<typeof row>;
      },
      confirmationSummary: (_input, summaryEnv) => {
        seen = summaryEnv;
        return "Revoke the customer record.";
      },
      auditTarget: () => ({ type: "fixture-crm", id: parityIds.crmSentinel }),
    });

    const error = await executeAction(deps(), {
      action,
      input: { customerId: parityIds.crmSentinel },
      request: requestMeta({ idempotencyKey: randomUUID() }),
      principal: {
        mode: "customer",
        session: { userId: parityIds.users.boris },
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect(seen?.companyId).toBe(parityIds.companies.published);
    expect(seen?.target).toMatchObject({ id: parityIds.crmSentinel });
  });
});
