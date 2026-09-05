/**
 * Integration tests for `ctx.callAtomic` (fnd-T19A — core.md §9,
 * ADR-0021) against the shared Testcontainers harness:
 *
 * - the declared edge commits atomically: root and callee writes, the
 *   callee's events, and both audit rows land in one physical
 *   transaction (same `Tx` identity), and the root's idempotency
 *   snapshot replays without re-running either handler;
 * - rollback: a root failure after the atomic call — and a callee
 *   failure (insufficient stock) — removes both modules' writes, all
 *   outbox rows, and every same-tx audit row;
 * - edge enforcement: undeclared edges (either direction), principal
 *   mismatch on a mutually declared edge, and read roots are
 *   `CoreInvariantError`s and the callee never runs;
 * - tenant protocol: a customer callee's resolver re-runs with the
 *   root's verified `inheritedCompanyId`; resolving another company is a
 *   `CoreInvariantError`;
 * - one atomic edge below the root: a second `ctx.callAtomic`, a nested
 *   atomic call from the atomic callee, and an atomic call from a read
 *   callee are all rejected; the callee's ordinary reads share the
 *   root's depth/cycle path;
 * - callee input/output validation, the escaped-context guard, and
 *   correlation-nested logs/spans.
 *
 * Define-time rules (an atomic callee cannot be `transport: "client"`,
 * cannot be a root and callee at once) are covered by the fnd-T8 contract
 * tests; the CI-side edge/graph rules live in `contract-check.test.ts`.
 * Schema confinement of the callee is the fnd-T25 ESLint boundary wall.
 */
import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  companyMembers,
  domainEvents,
  rolePermissionDefaults,
  type ReadTx,
  type Tx,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureCrmCustomers,
  fixtureDiscoveryProducts,
  fixtureProducts,
  parityIds,
  seedParityFixtures,
} from "@showzy/db/testing/fixtures";
import { and, eq, gte, sql } from "drizzle-orm";
import { pino, type Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConflictError,
  CoreError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import type { ActionCtx } from "../context/types.js";
import { defineEvent } from "../events/define-event.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "./execute-action.js";
import type {
  ActionPipelineDeps,
  ActionSpanFields,
  ActionSpanOutcome,
  ActionTelemetry,
  PipelineRequestMeta,
} from "./types.js";

let db: TestDatabase;

const users = {
  anna: "user_anna",
  boris: "user_boris",
} as const;
const companyA = randomUUID();
const companyB = randomUUID();

beforeAll(async () => {
  db = await createTestDatabase();
  await db.runtime.db.insert(user).values([
    { id: users.anna, name: "Anna", email: "anna@ctx-atomic.test" },
    { id: users.boris, name: "Boris", email: "boris@ctx-atomic.test" },
  ]);
  await db.runtime.db.insert(companies).values([
    { id: companyA, name: "Company A", slug: "ctx-atomic-a", prefix: "YA" },
    { id: companyB, name: "Company B", slug: "ctx-atomic-b", prefix: "YB" },
  ]);
  // Boris (manager) may run the root fixture but lacks the callee's
  // declared permission — the callee-denial case. Anna is owner-all.
  await db.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "manager", permission: "atomOrders:confirm" }]);
  await db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: companyB,
      userId: users.boris,
      role: "manager",
      permissions: { granted: [], denied: [] },
    },
  ]);
  await createParityFixtureTables(db.admin);
  await seedParityFixtures(db.runtime.db);
});

afterAll(async () => {
  await db.close();
});

// --- Test utilities ----------------------------------------------------------

const silentLogger = pino({ enabled: false });

function requestMeta(
  overrides: Partial<PipelineRequestMeta> = {},
): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: "203.0.113.9",
    ...overrides,
  };
}

/** The full protocol composition the root owns: real audit + idempotency. */
function depsFor(
  overrides: Partial<ActionPipelineDeps> = {},
): ActionPipelineDeps {
  return {
    db: db.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit: { enforce: () => Promise.resolve() },
      audit: createAuditHook({ db: db.runtime.db, logger: silentLogger }),
      idempotency: createIdempotencyHook({ db: db.runtime.db }),
    },
    ...overrides,
  };
}

function captureLogger(): {
  logger: Logger;
  entries: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = pino(
    { base: null },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  return {
    logger,
    entries: () =>
      lines
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

interface RecordedSpan {
  readonly fields: ActionSpanFields;
  readonly errors: unknown[];
  outcome?: ActionSpanOutcome;
}

function recordingTelemetry(): {
  telemetry: ActionTelemetry;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  return {
    spans,
    telemetry: {
      startSpan(fields) {
        const span: RecordedSpan = { fields, errors: [] };
        spans.push(span);
        return {
          recordError(error) {
            span.errors.push(error);
          },
          end(outcome) {
            span.outcome = outcome;
          },
        };
      },
    },
  };
}

async function expectCoreError<T extends CoreError>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
  }
  throw new Error(`expected ${errorClass.name}, but the promise resolved`);
}

/** Handlers narrow the union capability to the writable one they declared. */
function requireWritable(capability: ReadTx | Tx): Tx {
  if (!("insert" in capability)) {
    throw new CoreInvariantError(
      "fixture handler expected the writable capability",
    );
  }
  return capability;
}

/** Seeds one isolated tracked-stock row; returns its id. */
async function seedStock(unitsLeft: number): Promise<string> {
  const productId = randomUUID();
  await db.runtime.db.insert(fixtureDiscoveryProducts).values({
    productId,
    companyId: companyA,
    name: "Tracked stock fixture",
    likeCount: unitsLeft,
    commentCount: 0,
  });
  return productId;
}

async function stockOf(productId: string): Promise<number> {
  const rows = await db.runtime.db
    .select({ unitsLeft: fixtureDiscoveryProducts.likeCount })
    .from(fixtureDiscoveryProducts)
    .where(eq(fixtureDiscoveryProducts.productId, productId));
  return rows[0]?.unitsLeft ?? -1;
}

async function orderExists(orderId: string): Promise<boolean> {
  const rows = await db.runtime.db
    .select({ id: fixtureProducts.id })
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, orderId));
  return rows.length > 0;
}

async function eventsForAggregate(aggregateId: string) {
  return db.runtime.db
    .select({
      name: domainEvents.name,
      companyId: domainEvents.companyId,
      actorType: domainEvents.actorType,
      actorId: domainEvents.actorId,
      causationId: domainEvents.causationId,
    })
    .from(domainEvents)
    .where(eq(domainEvents.aggregateId, aggregateId))
    .orderBy(domainEvents.name);
}

async function auditRows(action: string, targetId: string) {
  return db.runtime.db
    .select({
      action: auditLog.action,
      outcome: auditLog.outcome,
      companyId: auditLog.companyId,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
    })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));
}

// --- Fixture actions ---------------------------------------------------------

const contractDefaults = {
  transport: "internal",
  aiExposure: "internal",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
} as const;

const stockAdjusted = defineEvent({
  name: "atomCatalog.stockAdjusted",
  version: 1,
  scope: "tenant",
  payload: z.object({ productId: z.uuid(), delta: z.number().int() }),
});

const orderConfirmed = defineEvent({
  name: "atomOrders.confirmed",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

/** Observations the fixtures record about their own contexts. */
const observed = {
  rootDb: undefined as unknown,
  calleeDb: undefined as unknown,
  calleeRuns: 0,
  rootRuns: 0,
};

/**
 * The atomic callee — the ADR-0021 catalog-stock capability shape:
 * lock-free single-statement conditional decrement of a tracked balance,
 * `ConflictError` when insufficient, its own event and audit.
 */
const decrementStock = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "atomCatalog.decrementStock",
    description: "Decrement tracked fixture stock inside the root tx.",
    principal: "staff",
    input: z.object({
      productId: z.uuid(),
      quantity: z.number().int().positive(),
    }),
    output: z.object({ unitsLeft: z.number().int() }),
    permissions: ["atomCatalog:manageStock"],
    risk: "write",
    audit: true,
    emits: ["atomCatalog.stockAdjusted"],
    atomicCallers: ["atomOrders.confirm"],
    timeout: 5_000,
  }),
  {
    handler: async (input, ctx) => {
      observed.calleeDb = ctx.db;
      observed.calleeRuns += 1;
      // Non-negative conditional decrement: zero updated rows means the
      // stock is insufficient (or foreign) — a domain conflict.
      const rows = await requireWritable(ctx.db)
        .update(fixtureDiscoveryProducts)
        .set({
          likeCount: sql`${fixtureDiscoveryProducts.likeCount} - ${input.quantity}`,
        })
        .where(
          and(
            eq(fixtureDiscoveryProducts.productId, input.productId),
            eq(fixtureDiscoveryProducts.companyId, ctx.companyId),
            gte(fixtureDiscoveryProducts.likeCount, input.quantity),
          ),
        )
        .returning({ unitsLeft: fixtureDiscoveryProducts.likeCount });
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictError("Insufficient stock.");
      }
      ctx.emit(stockAdjusted, {
        aggregate: { type: "fixture-stock", id: input.productId },
        payload: { productId: input.productId, delta: -input.quantity },
      });
      return row;
    },
    auditTarget: () => ({ type: "fixture-stock", id: "atomic-callee" }),
  },
);

/** The atomic root — the `orders.confirm` shape: own write, edge, event. */
const confirmOrder = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "atomOrders.confirm",
    description: "Confirm a fixture order and decrement stock atomically.",
    principal: "staff",
    input: z.object({
      orderId: z.uuid(),
      productId: z.uuid(),
      quantity: z.number().int().positive(),
      failAfterCall: z.boolean(),
    }),
    output: z.object({ unitsLeft: z.number().int() }),
    permissions: ["atomOrders:confirm"],
    risk: "write",
    idempotent: true,
    audit: true,
    emits: ["atomOrders.confirmed"],
    atomicCalls: ["atomCatalog.decrementStock"],
    timeout: 5_000,
  }),
  {
    handler: async (input, ctx) => {
      observed.rootDb = ctx.db;
      observed.rootRuns += 1;
      await requireWritable(ctx.db).insert(fixtureProducts).values({
        id: input.orderId,
        companyId: ctx.companyId,
        name: "Confirmed fixture order",
        published: false,
      });
      const stock = await ctx.callAtomic(decrementStock, {
        productId: input.productId,
        quantity: input.quantity,
      });
      ctx.emit(orderConfirmed, {
        aggregate: { type: "fixture-order", id: input.orderId },
        payload: { orderId: input.orderId },
      });
      if (input.failAfterCall) {
        throw new ConflictError("Root failed after the atomic call.");
      }
      return stock;
    },
    auditTarget: () => ({ type: "fixture-order", id: "atomic-root" }),
  },
);

function invokeConfirm(options: {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly failAfterCall?: boolean;
  readonly idempotencyKey?: string;
  readonly userId?: string;
  readonly companySelector?: string;
  readonly deps?: ActionPipelineDeps;
  readonly request?: Partial<PipelineRequestMeta>;
}) {
  return executeAction(options.deps ?? depsFor(), {
    action: confirmOrder,
    input: {
      orderId: options.orderId,
      productId: options.productId,
      quantity: options.quantity,
      failAfterCall: options.failAfterCall ?? false,
    },
    request: requestMeta({
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      ...options.request,
    }),
    principal: {
      mode: "staff",
      session: { userId: options.userId ?? users.anna },
      companySelector: options.companySelector ?? companyA,
    },
  });
}

/** Runs one throwaway staff write root (non-atomic) around `run`. */
function staffWriteRoot(
  name: string,
  run: (ctx: ActionCtx) => Promise<unknown>,
  deps?: ActionPipelineDeps,
): Promise<unknown> {
  const action = implementAction(
    defineActionContract({
      ...contractDefaults,
      name,
      description: "Throwaway staff write root for ctx.callAtomic tests.",
      principal: "staff",
      input: z.object({}),
      output: z.unknown(),
      permissions: ["atomOrders:confirm"],
      risk: "write",
      idempotent: true,
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: (_input, ctx) => run(ctx).then((value) => value ?? null),
      auditTarget: () => ({ type: "fixture", id: "throwaway-root" }),
    },
  );
  return executeAction(deps ?? depsFor(), {
    action,
    input: {},
    request: requestMeta({ idempotencyKey: randomUUID() }),
    principal: {
      mode: "staff",
      session: { userId: users.anna },
      companySelector: companyA,
    },
  });
}

// --- Atomic commit and replay ------------------------------------------------

describe("declared edge execution (ADR-0021)", () => {
  it("commits root and callee writes, events, and audit in one transaction", async () => {
    const orderId = randomUUID();
    const productId = await seedStock(5);
    const requestId = randomUUID();

    const output = await invokeConfirm({
      orderId,
      productId,
      quantity: 2,
      request: { requestId },
    });
    expect(output).toEqual({ unitsLeft: 3 });

    // Same physical transaction: the callee held the exact `Tx` object
    // the root handler held — writable, no facade, no savepoint wrapper.
    expect(observed.calleeDb).toBe(observed.rootDb);
    expect(observed.calleeDb).not.toBe(undefined);

    // Both modules' writes committed together.
    expect(await orderExists(orderId)).toBe(true);
    expect(await stockOf(productId)).toBe(3);

    // The callee's event carries its own name, the verified company, the
    // accountable root actor, and the root's causation chain.
    expect(await eventsForAggregate(productId)).toEqual([
      {
        name: "atomCatalog.stockAdjusted",
        companyId: companyA,
        actorType: "user",
        actorId: users.anna,
        causationId: requestId,
      },
    ]);
    expect(await eventsForAggregate(orderId)).toEqual([
      {
        name: "atomOrders.confirmed",
        companyId: companyA,
        actorType: "user",
        actorId: users.anna,
        causationId: requestId,
      },
    ]);

    // One audit row per side, both scoped to the verified company.
    expect(
      await auditRows("atomCatalog.decrementStock", "atomic-callee"),
    ).toEqual([
      {
        action: "atomCatalog.decrementStock",
        outcome: "ok",
        companyId: companyA,
        actorType: "user",
        actorId: users.anna,
      },
    ]);
    expect(await auditRows("atomOrders.confirm", "atomic-root")).toContainEqual(
      {
        action: "atomOrders.confirm",
        outcome: "ok",
        companyId: companyA,
        actorType: "user",
        actorId: users.anna,
      },
    );
  });

  it("replays the root's stored response without re-running either handler", async () => {
    const orderId = randomUUID();
    const productId = await seedStock(5);
    const idempotencyKey = randomUUID();
    const invoke = () =>
      invokeConfirm({ orderId, productId, quantity: 2, idempotencyKey });

    const first = await invoke();
    const rootRuns = observed.rootRuns;
    const calleeRuns = observed.calleeRuns;

    // The root owns the idempotency protocol: the snapshot committed with
    // the transaction, so the replay returns it without any execution and
    // the stock is not decremented twice.
    const replayed = await invoke();
    expect(replayed).toEqual(first);
    expect(observed.rootRuns).toBe(rootRuns);
    expect(observed.calleeRuns).toBe(calleeRuns);
    expect(await stockOf(productId)).toBe(3);
  });
});

// --- Rollback ------------------------------------------------------------

describe("atomic rollback (ADR-0021)", () => {
  it("rolls back both modules' writes, events, and audit when the root fails after the call", async () => {
    const orderId = randomUUID();
    const productId = await seedStock(5);
    const calleeAuditBefore = (
      await auditRows("atomCatalog.decrementStock", "atomic-callee")
    ).length;

    const error = await expectCoreError(
      invokeConfirm({ orderId, productId, quantity: 2, failAfterCall: true }),
      ConflictError,
    );
    expect(error.clientMessage).toBe("Root failed after the atomic call.");

    // The callee ran and had decremented — everything rolled back.
    expect(await orderExists(orderId)).toBe(false);
    expect(await stockOf(productId)).toBe(5);
    expect(await eventsForAggregate(productId)).toEqual([]);
    expect(await eventsForAggregate(orderId)).toEqual([]);
    // The callee's same-tx audit row rolled back with everything else;
    // the root's CONFLICT outcome is recorded by the separate
    // failure-path transaction.
    expect(
      await auditRows("atomCatalog.decrementStock", "atomic-callee"),
    ).toHaveLength(calleeAuditBefore);
    expect(await auditRows("atomOrders.confirm", "atomic-root")).toContainEqual(
      expect.objectContaining({ outcome: "CONFLICT" }),
    );
  });

  it("rolls back the root's writes when the callee rejects insufficient stock", async () => {
    const orderId = randomUUID();
    const productId = await seedStock(1);
    const idempotencyKey = randomUUID();

    const error = await expectCoreError(
      invokeConfirm({ orderId, productId, quantity: 3, idempotencyKey }),
      ConflictError,
    );
    expect(error.clientMessage).toBe("Insufficient stock.");
    expect(await orderExists(orderId)).toBe(false);
    expect(await stockOf(productId)).toBe(1);
    expect(await eventsForAggregate(orderId)).toEqual([]);

    // The reservation was marked failed, not completed: the same key with
    // the same payload re-executes instead of replaying a phantom result.
    const rootRuns = observed.rootRuns;
    await expectCoreError(
      invokeConfirm({ orderId, productId, quantity: 3, idempotencyKey }),
      ConflictError,
    );
    expect(observed.rootRuns).toBe(rootRuns + 1);
  });
});

// --- Edge enforcement ----------------------------------------------------

describe("edge enforcement (ADR-0021)", () => {
  /** An internal write callee that acknowledges no callers. */
  const looseStockWrite = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "atomCatalog.recountStock",
      description: "Internal catalog write without declared atomic callers.",
      principal: "staff",
      input: z.object({}),
      output: z.object({}),
      permissions: ["atomCatalog:manageStock"],
      risk: "write",
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: () => {
        observed.calleeRuns += 1;
        return Promise.resolve({});
      },
      auditTarget: () => ({ type: "fixture-stock", id: "loose" }),
    },
  );

  it("rejects an edge the callee does not declare", async () => {
    const undeclaredRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomOrders.recount",
        description: "Root declaring an edge the callee does not return.",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomCatalog.recountStock"],
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.callAtomic(looseStockWrite, {});
          return {};
        },
        auditTarget: () => ({ type: "fixture-order", id: "undeclared" }),
      },
    );

    const calleeRuns = observed.calleeRuns;
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: undeclaredRoot,
        input: {},
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      '"atomCatalog.recountStock" does not list "atomOrders.recount" in atomicCallers',
    );
    expect(observed.calleeRuns).toBe(calleeRuns);
  });

  it("rejects a caller that declares no edge at all", async () => {
    const calleeRuns = observed.calleeRuns;
    const error = await expectCoreError(
      staffWriteRoot("atomOrders.sneak", (ctx) =>
        ctx.callAtomic(decrementStock, {
          productId: randomUUID(),
          quantity: 1,
        }),
      ),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      '"atomOrders.sneak" does not list "atomCatalog.decrementStock" in atomicCalls',
    );
    expect(observed.calleeRuns).toBe(calleeRuns);
  });

  it("rejects a principal mismatch on a mutually declared edge", async () => {
    const staffCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomCatalog.rebuildStock",
        description: "Staff catalog write declared for a system root (bug).",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["atomCatalog:manageStock"],
        risk: "write",
        audit: true,
        atomicCallers: ["atomSysOrders.sweep"],
        timeout: 5_000,
      }),
      {
        handler: () => {
          observed.calleeRuns += 1;
          return Promise.resolve({});
        },
        auditTarget: () => ({ type: "fixture-stock", id: "rebuild" }),
      },
    );
    const systemRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomSysOrders.sweep",
        description: "System root reaching a staff atomic callee (a bug).",
        principal: "system",
        systemScope: "tenant",
        permissions: [],
        input: z.object({}),
        output: z.object({}),
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomCatalog.rebuildStock"],
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.callAtomic(staffCallee, {});
          return {};
        },
        auditTarget: () => ({ type: "fixture-sweep", id: "mismatch" }),
      },
    );

    const calleeRuns = observed.calleeRuns;
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: systemRoot,
        input: {},
        request: requestMeta({
          channel: "system",
          idempotencyKey: randomUUID(),
        }),
        principal: {
          mode: "system",
          serviceName: "ctx-atomic-fixture",
          scope: { scope: "tenant", companyId: companyA },
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("must use the same principal mode");
    expect(observed.calleeRuns).toBe(calleeRuns);
  });

  it("propagates the callee's permission denial and rolls the root back", async () => {
    // Boris (manager of company B) holds "atomOrders:confirm" via the
    // role default but not the callee's "atomCatalog:manageStock".
    const orderId = randomUUID();
    await expectCoreError(
      invokeConfirm({
        orderId,
        productId: randomUUID(),
        quantity: 1,
        userId: users.boris,
        companySelector: companyB,
      }),
      // The callee's declared permissions re-check inside the root tx.
      PermissionDeniedError,
    );
    expect(await orderExists(orderId)).toBe(false);
  });

  it("a read root cannot make atomic calls", async () => {
    const readRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomReports.preview",
        description: "Read root reaching for an atomic write (a bug).",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.callAtomic(decrementStock, {
            productId: randomUUID(),
            quantity: 1,
          });
          return {};
        },
      },
    );
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: readRoot,
        input: {},
        request: requestMeta(),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("available only to writable root actions");
  });
});

// --- Tenant protocol -------------------------------------------------------

describe("tenant scope on customer atomic edges", () => {
  it("treats a callee resolver crossing tenants as a CoreInvariantError", async () => {
    const foreignEnsure = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomCrm.ensureRecord",
        description: "Customer CRM capability whose resolver crosses tenants.",
        principal: "customer",
        permissions: [],
        input: z.object({ customerId: z.uuid() }),
        output: z.object({}),
        risk: "write",
        audit: true,
        atomicCallers: ["atomCheckout.create"],
        timeout: 5_000,
      }),
      {
        handler: () => Promise.resolve({}),
        // The buggy variant: resolves a fixed foreign company instead of
        // the caller's verified scope.
        resolveTarget: () =>
          Promise.resolve({
            companyId: parityIds.companies.unpublished,
            resource: null,
          }),
        auditTarget: () => ({ type: "fixture-crm", id: "ensure" }),
      },
    );
    const checkout = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomCheckout.create",
        description: "Customer checkout composing the CRM atomic capability.",
        principal: "customer",
        permissions: [],
        input: z.object({ customerId: z.uuid() }),
        output: z.object({}),
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomCrm.ensureRecord"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await ctx.callAtomic(foreignEnsure, input);
          return {};
        },
        resolveTarget: async (input, env) => {
          if (env.principal.mode !== "customer") {
            throw new NotFoundError();
          }
          const rows = await env.tx
            .select()
            .from(fixtureCrmCustomers)
            .where(eq(fixtureCrmCustomers.id, input.customerId))
            .limit(1);
          const row = rows[0];
          if (row === undefined || row.userId !== env.principal.userId) {
            throw new NotFoundError();
          }
          return { companyId: row.companyId, resource: row };
        },
        auditTarget: () => ({ type: "fixture-checkout", id: "create" }),
      },
    );

    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: checkout,
        input: { customerId: parityIds.crmSentinel },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "customer",
          session: { userId: parityIds.users.boris },
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("expected inherited company");
  });
});

// --- One atomic edge below the root ---------------------------------------

describe("one atomic edge below the root", () => {
  it("rejects a second atomic call from the same root invocation", async () => {
    // A callee that mutually declares this root, so the first call passes
    // every edge rule and only the latch can reject the second.
    const touchStock = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomCatalog.touchStock",
        description: "Mutually declared atomic write for the latch test.",
        principal: "staff",
        input: z.object({ productId: z.uuid() }),
        output: z.object({}),
        permissions: ["atomCatalog:manageStock"],
        risk: "write",
        audit: true,
        atomicCallers: ["atomOrders.confirmTwice"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          observed.calleeRuns += 1;
          await requireWritable(ctx.db)
            .update(fixtureDiscoveryProducts)
            .set({
              likeCount: sql`${fixtureDiscoveryProducts.likeCount} - 1`,
            })
            .where(
              and(
                eq(fixtureDiscoveryProducts.productId, input.productId),
                eq(fixtureDiscoveryProducts.companyId, ctx.companyId),
              ),
            );
          return {};
        },
        auditTarget: () => ({ type: "fixture-stock", id: "touch" }),
      },
    );
    const doubleRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomOrders.confirmTwice",
        description: "Root invoking its declared atomic edge twice (a bug).",
        principal: "staff",
        input: z.object({ productId: z.uuid() }),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomCatalog.touchStock"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await ctx.callAtomic(touchStock, { productId: input.productId });
          await ctx.callAtomic(touchStock, { productId: input.productId });
          return {};
        },
        auditTarget: () => ({ type: "fixture-order", id: "twice" }),
      },
    );

    const productId = await seedStock(5);
    const calleeRuns = observed.calleeRuns;
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: doubleRoot,
        input: { productId },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      "only one atomic edge is allowed below the root",
    );
    // The callee ran exactly once and its write rolled back with the root.
    expect(observed.calleeRuns).toBe(calleeRuns + 1);
    expect(await stockOf(productId)).toBe(5);
  });

  it("rejects a nested atomic call from the atomic callee", async () => {
    const nestedCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomInventory.cascade",
        description: "Atomic callee attempting a further atomic call (a bug).",
        principal: "staff",
        input: z.object({ productId: z.uuid() }),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "write",
        audit: true,
        atomicCallers: ["atomOrders.confirmCascade"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await ctx.callAtomic(decrementStock, {
            productId: input.productId,
            quantity: 1,
          });
          return {};
        },
        auditTarget: () => ({ type: "fixture-inventory", id: "cascade" }),
      },
    );
    const cascadeRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomOrders.confirmCascade",
        description: "Root whose atomic callee cascades (a bug).",
        principal: "staff",
        input: z.object({ productId: z.uuid() }),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomInventory.cascade"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await ctx.callAtomic(nestedCallee, input);
          return {};
        },
        auditTarget: () => ({ type: "fixture-order", id: "cascade" }),
      },
    );

    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: cascadeRoot,
        input: { productId: randomUUID() },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      "atomic calls may originate only from the root action",
    );
  });

  it("rejects an atomic call from a nested read callee", async () => {
    const sneakyRead = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomFacts.peekAndWrite",
        description: "Read callee attempting an atomic write (a bug).",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.callAtomic(decrementStock, {
            productId: randomUUID(),
            quantity: 1,
          });
          return {};
        },
      },
    );
    const error = await expectCoreError(
      staffWriteRoot("atomOrders.readThenWrite", (ctx) =>
        ctx.call(sneakyRead, {}),
      ),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      "atomic calls may originate only from the root action",
    );
  });

  it("counts the atomic hop against the shared read depth/cycle path", async () => {
    const stepOutput = z.object({ reached: z.string() });
    const stepInput = z.object({});
    type ChainStep = ImplementedAction<typeof stepInput, typeof stepOutput>;
    function mkStep(module: string, next?: () => ChainStep): ChainStep {
      return implementAction(
        defineActionContract({
          ...contractDefaults,
          name: `${module}.step`,
          description: "One link of the atomic depth chain.",
          principal: "staff",
          input: stepInput,
          output: stepOutput,
          permissions: ["atomOrders:confirm"],
          risk: "read",
          audit: false,
          timeout: 5_000,
        }),
        {
          handler: async (_input, ctx) => {
            if (next === undefined) {
              return { reached: module };
            }
            return await ctx.call(next(), {});
          },
        },
      );
    }
    const step3 = mkStep("atomChainC");
    const step2 = mkStep("atomChainB", () => step3);
    const step1 = mkStep("atomChainA", () => step2);
    const chainCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomInventory.chainReads",
        description: "Atomic callee composing a deep read chain.",
        principal: "staff",
        input: z.object({}),
        output: stepOutput,
        permissions: ["atomOrders:confirm"],
        risk: "write",
        audit: true,
        atomicCallers: ["atomOrders.confirmChain"],
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => ctx.call(step1, {}),
        auditTarget: () => ({ type: "fixture-inventory", id: "chain" }),
      },
    );
    const chainRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomOrders.confirmChain",
        description: "Root whose atomic callee reads too deeply.",
        principal: "staff",
        input: z.object({}),
        output: stepOutput,
        permissions: ["atomOrders:confirm"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomInventory.chainReads"],
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => ctx.callAtomic(chainCallee, {}),
        auditTarget: () => ({ type: "fixture-order", id: "chain" }),
      },
    );

    // root → atomic callee → A → B is within the limit of 3 nested calls
    // below the root only when the atomic hop does NOT count; it does, so
    // the fourth path element (step C) must be rejected.
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: chainRoot,
        input: {},
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("depth limit of 3 exceeded");
    expect(error.message).toContain(
      "atomOrders.confirmChain → atomInventory.chainReads → atomChainA.step → atomChainB.step → atomChainC.step",
    );
  });
});

// --- Validation, escape, observability -------------------------------------

describe("callee validation and the escaped-context guard", () => {
  it("validates callee input like a transport invocation", async () => {
    const productId = await seedStock(5);
    await expectCoreError(
      invokeConfirm({ orderId: randomUUID(), productId, quantity: 0 }),
      ValidationError,
    );
    expect(await stockOf(productId)).toBe(5);
  });

  it("maps a callee output mismatch to CoreInvariantError and rolls back", async () => {
    const badOutputCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomCatalog.misreportStock",
        description: "Atomic callee violating its own output schema.",
        principal: "staff",
        input: z.object({}),
        output: z.object({ unitsLeft: z.number().int().nonnegative() }),
        permissions: ["atomCatalog:manageStock"],
        risk: "write",
        audit: true,
        atomicCallers: ["atomOrders.confirmMisreport"],
        timeout: 5_000,
      }),
      {
        // Compiles (a number) but violates the schema (negative).
        handler: () => Promise.resolve({ unitsLeft: -1 }),
        auditTarget: () => ({ type: "fixture-stock", id: "misreport" }),
      },
    );
    const misreportRoot = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "atomOrders.confirmMisreport",
        description: "Root composing the misreporting callee.",
        principal: "staff",
        input: z.object({ orderId: z.uuid() }),
        output: z.object({}),
        permissions: ["atomOrders:confirm"],
        risk: "write",
        idempotent: true,
        audit: true,
        atomicCalls: ["atomCatalog.misreportStock"],
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await requireWritable(ctx.db).insert(fixtureProducts).values({
            id: input.orderId,
            companyId: ctx.companyId,
            name: "Misreported order",
            published: false,
          });
          await ctx.callAtomic(badOutputCallee, {});
          return {};
        },
        auditTarget: () => ({ type: "fixture-order", id: "misreport" }),
      },
    );

    const orderId = randomUUID();
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: misreportRoot,
        input: { orderId },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error.message).toContain("failed the declared output schema");
    expect(await orderExists(orderId)).toBe(false);
  });

  it("refuses to run from a context that escaped its handler", async () => {
    let leaked: ActionCtx | undefined;
    await staffWriteRoot("atomOrders.leakCtx", (ctx) => {
      leaked = ctx;
      return Promise.resolve({});
    });
    if (leaked === undefined) {
      throw new Error("fixture handler did not run");
    }
    const error = await expectCoreError(
      leaked.callAtomic(decrementStock, {
        productId: randomUUID(),
        quantity: 1,
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("outside its handler execution");
  });
});

describe("atomic observability", () => {
  it("emits correlation-nested log lines and one span for the atomic call", async () => {
    const { logger, entries } = captureLogger();
    const { telemetry, spans } = recordingTelemetry();
    const correlationId = randomUUID();
    const productId = await seedStock(5);
    await invokeConfirm({
      orderId: randomUUID(),
      productId,
      quantity: 1,
      deps: depsFor({ logger, telemetry }),
      request: { correlationId },
    });

    const atomicStart = entries().find(
      (line) => line["msg"] === "atomic call started",
    );
    const atomicFinish = entries().find(
      (line) => line["msg"] === "atomic call finished",
    );
    expect(atomicStart).toMatchObject({
      action: "atomCatalog.decrementStock",
      caller_action: "atomOrders.confirm",
      correlation_id: correlationId,
    });
    expect(atomicFinish).toMatchObject({
      action: "atomCatalog.decrementStock",
      outcome: "ok",
      actor_id: users.anna,
      company_id: companyA,
    });

    expect(spans).toHaveLength(2);
    const [rootSpan, atomicSpan] = spans;
    expect(rootSpan?.fields.action).toBe("atomOrders.confirm");
    expect(atomicSpan?.fields).toMatchObject({
      action: "atomCatalog.decrementStock",
      correlationId,
    });
    expect(atomicSpan?.outcome).toMatchObject({
      outcome: "ok",
      companyId: companyA,
    });
  });
});
