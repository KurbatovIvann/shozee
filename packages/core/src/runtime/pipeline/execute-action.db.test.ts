/**
 * Integration tests for the execution pipeline (fnd-T12 — core.md §4)
 * against the shared Testcontainers harness:
 *
 * - the fixed step order, observable through instrumented protocol hooks
 *   and a twice-running target resolver (preflight + TOCTOU re-auth);
 * - transactionality: a failing handler and an output-schema mismatch roll
 *   back every same-transaction write;
 * - `risk: read` runs in a database read-only transaction (a runtime write
 *   attempt fails at the database) with the `ReadTx` capability;
 * - deadline enforcement: `TimeoutError`, the shared abort signal, and the
 *   transaction-local statement timeout;
 * - idempotency replay, failure-path hooks, structured start/finish log
 *   lines, and the telemetry seam.
 */
import { randomUUID } from "node:crypto";

import {
  companies,
  companyMembers,
  createProjectionGrantManifest,
  rolePermissionDefaults,
  type ReadTx,
  type Tx,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureCrmCustomers,
  fixtureDiscoveryGrant,
  fixtureDiscoveryProducts,
  fixtureProducts,
  parityIds,
  seedParityFixtures,
} from "@showzy/db/testing/fixtures";
import { eq, sql } from "drizzle-orm";
import { pino, type Logger } from "pino";
import {
  afterAll,
  beforeAll,
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
  NotFoundError,
  PermissionDeniedError,
  TimeoutError,
  ValidationError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import { implementAction } from "../implement-action.js";
import type { ResolvedTarget, TargetResolutionEnv } from "../types.js";
import { executeAction } from "./execute-action.js";
import type {
  ActionPipelineDeps,
  ActionSpanFields,
  ActionSpanOutcome,
  ActionTelemetry,
  PipelineHooks,
  PipelineRequestMeta,
  RateLimitHook,
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
    { id: users.anna, name: "Anna", email: "anna@example.test" },
    { id: users.boris, name: "Boris", email: "boris@example.test" },
  ]);
  await db.runtime.db.insert(companies).values([
    { id: companyA, name: "Company A", slug: "company-a", prefix: "CA" },
    { id: companyB, name: "Company B", slug: "company-b", prefix: "CB" },
  ]);
  await db.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "manager", permission: "pipelineFixture:read" }]);
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

// --- Test utilities ---------------------------------------------------------

const silentLogger = pino({ enabled: false });

const noopRateLimit: RateLimitHook = {
  enforce: () => Promise.resolve(),
};

function defaultHooks(): PipelineHooks {
  return {
    rateLimit: noopRateLimit,
    audit: createAuditHook({ db: db.runtime.db, logger: silentLogger }),
    idempotency: createIdempotencyHook({ db: db.runtime.db }),
  };
}

function depsFor(
  overrides: Partial<ActionPipelineDeps> = {},
): ActionPipelineDeps {
  return {
    db: db.runtime.db,
    logger: silentLogger,
    hooks: defaultHooks(),
    ...overrides,
    ...(overrides.hooks !== undefined
      ? { hooks: { ...defaultHooks(), ...overrides.hooks } }
      : {}),
  };
}

function requestMeta(
  overrides: Partial<PipelineRequestMeta> = {},
): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: "203.0.113.7",
    idempotencyKey: randomUUID(),
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

async function productExists(id: string): Promise<boolean> {
  const rows = await db.runtime.db
    .select({ id: fixtureProducts.id })
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, id));
  return rows.length > 0;
}

/** `current_setting('statement_timeout')` formats as e.g. "4987ms" or "5s". */
function parseStatementTimeout(value: string): number {
  const match = /^(\d+)(ms|s)?$/.exec(value);
  if (match === null) {
    throw new Error(`unexpected statement_timeout format: ${value}`);
  }
  return match[2] === "s" ? Number(match[1]) * 1000 : Number(match[1]);
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

/** The staff write fixture: inserts one row, optionally failing afterwards. */
const createProductContract = defineActionContract({
  ...contractDefaults,
  name: "pipelineFixture.createProduct",
  description: "Create one fixture product for pipeline tests.",
  principal: "staff",
  input: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    failAfterInsert: z.boolean().default(false),
  }),
  output: z.object({ id: z.uuid() }),
  permissions: ["pipelineFixture:write"],
  risk: "write",
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const createProduct = implementAction(createProductContract, {
  handler: async (input, ctx) => {
    await requireWritable(ctx.db).insert(fixtureProducts).values({
      id: input.id,
      companyId: ctx.companyId,
      name: input.name,
      published: false,
    });
    if (input.failAfterInsert) {
      throw new ConflictError("Fixture failure requested.");
    }
    return { id: input.id };
  },
  auditTarget: () => ({ type: "fixture-product", id: "fixture" }),
});

function invokeCreateProduct(options: {
  readonly input: unknown;
  readonly deps?: ActionPipelineDeps;
  readonly userId?: string;
  readonly companySelector?: string | null;
  readonly request?: Partial<PipelineRequestMeta>;
}) {
  return executeAction(options.deps ?? depsFor(), {
    action: createProduct,
    input: options.input,
    request: requestMeta(options.request),
    principal: {
      mode: "staff",
      session: { userId: options.userId ?? users.anna },
      companySelector:
        options.companySelector !== undefined
          ? options.companySelector
          : companyA,
    },
  });
}

type CrmRow = typeof fixtureCrmCustomers.$inferSelect;

// --- Tests -------------------------------------------------------------------

describe("pipeline step order (§4)", () => {
  it("runs rate limit → preflight resolver → confirmation → reserve → in-tx resolver → handler → audit → finalize", async () => {
    const steps: string[] = [];

    const confirmContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.confirmCrmThing",
      description: "Confirmation-gated customer fixture for order tests.",
      principal: "customer",
      transport: "client",
      input: z.object({ customerId: z.uuid() }),
      output: z.object({ companyId: z.uuid() }),
      permissions: [],
      risk: "high",
      requiresConfirmation: true,
      idempotent: true,
      audit: true,
      timeout: 5_000,
    });
    const confirmAction = implementAction(confirmContract, {
      handler: (_input, ctx) => {
        steps.push("handler");
        return Promise.resolve({ companyId: ctx.target.companyId });
      },
      resolveTarget: async (
        input: { customerId: string },
        env: TargetResolutionEnv,
      ): Promise<ResolvedTarget<CrmRow>> => {
        steps.push("resolveTarget");
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
      confirmationSummary: () => "Confirm the fixture operation.",
      auditTarget: () => ({ type: "fixture-crm", id: parityIds.crmSentinel }),
    });

    let summary: string | undefined;
    let gateCompanyId: string | null | undefined;
    const hooks: PipelineHooks = {
      rateLimit: {
        enforce: () => {
          steps.push("rateLimit");
          return Promise.resolve();
        },
      },
      confirmation: {
        gate: async (env) => {
          steps.push("confirmation");
          gateCompanyId = env.authorization.companyId;
          summary = await env.summarize();
          return {
            challengeId: randomUUID(),
            confirmedAt: new Date(),
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          };
        },
      },
      idempotency: {
        probe: () => {
          steps.push("idempotency.probe");
          return Promise.resolve({ kind: "fresh" as const });
        },
        reserve: () => {
          steps.push("idempotency.reserve");
          return Promise.resolve({
            kind: "execute" as const,
            reservation: "reservation-1",
          });
        },
        finalize: () => {
          steps.push("idempotency.finalize");
          return Promise.resolve();
        },
        markFailed: () => {
          steps.push("idempotency.markFailed");
          return Promise.resolve();
        },
      },
      audit: {
        recordSuccess: () => {
          steps.push("audit.recordSuccess");
          return Promise.resolve();
        },
        recordFailure: () => {
          steps.push("audit.recordFailure");
          return Promise.resolve();
        },
      },
    };

    const output = await executeAction(depsFor({ hooks }), {
      action: confirmAction,
      input: { customerId: parityIds.crmSentinel },
      request: requestMeta(),
      principal: {
        mode: "customer",
        session: { userId: parityIds.users.boris },
      },
    });

    expect(output).toEqual({ companyId: parityIds.companies.published });
    // The resolver runs twice by design: once in the preflight's read-only
    // transaction, once inside the execution transaction (TOCTOU re-auth).
    expect(steps).toEqual([
      "rateLimit",
      "resolveTarget",
      "idempotency.probe",
      "confirmation",
      "idempotency.reserve",
      "resolveTarget",
      "handler",
      "audit.recordSuccess",
      "idempotency.finalize",
    ]);
    expect(summary).toBe("Confirm the fixture operation.");
    // The confirmation hook sees the preflight-verified company scope.
    expect(gateCompanyId).toBe(parityIds.companies.published);
  });

  it("replays a completed confirmation without consuming the challenge", async () => {
    let gateCalls = 0;
    let handlerRuns = 0;
    const replayContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.confirmReplay",
      description: "Confirmation-gated staff fixture for probe replay.",
      principal: "staff",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permissions: ["pipelineFixture:write"],
      risk: "high",
      requiresConfirmation: true,
      idempotent: true,
      audit: true,
      timeout: 5_000,
    });
    const replayAction = implementAction(replayContract, {
      handler: () => {
        handlerRuns += 1;
        return Promise.resolve({ ok: true });
      },
      confirmationSummary: () => "unused",
      auditTarget: () => ({ type: "fixture-product", id: "fixture" }),
    });

    const output = await executeAction(
      depsFor({
        hooks: {
          confirmation: {
            gate: () => {
              gateCalls += 1;
              return Promise.resolve({
                challengeId: randomUUID(),
                confirmedAt: new Date(),
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
              });
            },
          },
          idempotency: {
            probe: () =>
              Promise.resolve({
                kind: "replay" as const,
                response: { ok: true },
              }),
            reserve: () =>
              Promise.reject(new Error("reserve must not run on probe replay")),
            finalize: () =>
              Promise.reject(
                new Error("finalize must not run on probe replay"),
              ),
            markFailed: () =>
              Promise.reject(
                new Error("markFailed must not run on probe replay"),
              ),
          },
        },
      }),
      {
        action: replayAction,
        input: {},
        request: requestMeta(),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      },
    );

    expect(output).toEqual({ ok: true });
    expect(gateCalls).toBe(0);
    expect(handlerRuns).toBe(0);
  });

  it("validates input before anything else — no rate limit, no handler, no side effects", async () => {
    const steps: string[] = [];
    const hooks: PipelineHooks = {
      rateLimit: {
        enforce: () => {
          steps.push("rateLimit");
          return Promise.resolve();
        },
      },
    };
    const error = await expectCoreError(
      invokeCreateProduct({
        input: { id: "not-a-uuid", name: "" },
        deps: depsFor({ hooks }),
      }),
      ValidationError,
    );
    expect(error.issues.length).toBeGreaterThan(0);
    expect(steps).toEqual([]);
  });

  it("authenticates before rate limiting — a missing session never reaches the hook", async () => {
    const steps: string[] = [];
    const hooks: PipelineHooks = {
      rateLimit: {
        enforce: () => {
          steps.push("rateLimit");
          return Promise.resolve();
        },
      },
    };
    await expectCoreError(
      executeAction(depsFor({ hooks }), {
        action: createProduct,
        input: { id: randomUUID(), name: "No session" },
        request: requestMeta(),
        principal: { mode: "staff", session: null, companySelector: companyA },
      }),
      PermissionDeniedError,
    );
    expect(steps).toEqual([]);
  });
});

describe("authorization", () => {
  it("denies a staff caller lacking a declared permission before the handler runs", async () => {
    const productId = randomUUID();
    let failureCode: string | undefined;
    const hooks: PipelineHooks = {
      audit: {
        recordSuccess: () => Promise.resolve(),
        recordFailure: (env) => {
          failureCode = env.error.code;
          return Promise.resolve();
        },
      },
    };
    // Boris is a manager of company B with only "pipelineFixture:read".
    await expectCoreError(
      invokeCreateProduct({
        input: { id: productId, name: "Denied" },
        deps: depsFor({ hooks }),
        userId: users.boris,
        companySelector: companyB,
      }),
      PermissionDeniedError,
    );
    expect(await productExists(productId)).toBe(false);
    // The failed outcome is recorded through the audit slot (§8 denials).
    expect(failureCode).toBe("PERMISSION_DENIED");
  });

  it("treats a transport invoking the wrong principal mode as a core invariant violation", async () => {
    await expectCoreError(
      executeAction(depsFor(), {
        action: createProduct,
        input: { id: randomUUID(), name: "Wrong mode" },
        request: requestMeta({ channel: "system" }),
        principal: {
          mode: "system",
          serviceName: "fixture-worker",
          scope: { scope: "tenant", companyId: companyA },
        },
      }),
      CoreInvariantError,
    );
  });

  it("rejects a system invocation whose scope contradicts the declared systemScope", async () => {
    const systemContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.systemTouch",
      description: "Tenant-scoped system fixture.",
      principal: "system",
      systemScope: "tenant",
      input: z.object({ id: z.uuid() }),
      output: z.object({ companyId: z.uuid() }),
      permissions: [],
      risk: "write",
      audit: true,
      timeout: 5_000,
    });
    const systemTouch = implementAction(systemContract, {
      handler: async (input, ctx) => {
        if (ctx.scope !== "tenant") {
          throw new CoreInvariantError(
            "fixture expects a tenant system context",
          );
        }
        await requireWritable(ctx.db).insert(fixtureProducts).values({
          id: input.id,
          companyId: ctx.companyId,
          name: "System-created",
          published: false,
        });
        return { companyId: ctx.companyId };
      },
      auditTarget: () => ({ type: "fixture-product", id: "system" }),
    });

    await expectCoreError(
      executeAction(depsFor(), {
        action: systemTouch,
        input: { id: randomUUID() },
        request: requestMeta({ channel: "system" }),
        principal: {
          mode: "system",
          serviceName: "fixture-worker",
          scope: { scope: "global" },
        },
      }),
      CoreInvariantError,
    );

    // The matching scope executes and writes under the explicit company.
    const productId = randomUUID();
    const output = await executeAction(depsFor(), {
      action: systemTouch,
      input: { id: productId },
      request: requestMeta({ channel: "system" }),
      principal: {
        mode: "system",
        serviceName: "fixture-worker",
        scope: { scope: "tenant", companyId: companyA },
      },
    });
    expect(output).toEqual({ companyId: companyA });
    expect(await productExists(productId)).toBe(true);
  });
});

describe("transactionality (§4 steps 7–10)", () => {
  it("rolls back every same-transaction write when the handler fails", async () => {
    const productId = randomUUID();
    let markedFailed: { reservation: unknown; code: string } | undefined;
    let failureRecorded: string | undefined;
    const hooks: PipelineHooks = {
      idempotency: {
        probe: () => Promise.resolve({ kind: "fresh" as const }),
        reserve: () =>
          Promise.resolve({ kind: "execute" as const, reservation: "res-42" }),
        finalize: () =>
          Promise.reject(
            new Error("finalize must not run for a failed handler"),
          ),
        markFailed: ({ reservation, error }) => {
          markedFailed = { reservation, code: error.code };
          return Promise.resolve();
        },
      },
      audit: {
        recordSuccess: () =>
          Promise.reject(
            new Error("recordSuccess must not run for a failed handler"),
          ),
        recordFailure: (env) => {
          failureRecorded = env.error.code;
          return Promise.resolve();
        },
      },
    };

    const error = await expectCoreError(
      invokeCreateProduct({
        input: { id: productId, name: "Rolls back", failAfterInsert: true },
        deps: depsFor({ hooks }),
      }),
      ConflictError,
    );
    expect(error.clientMessage).toBe("Fixture failure requested.");
    // The insert happened inside the execution transaction and must be gone.
    expect(await productExists(productId)).toBe(false);
    // Failed outcomes are recorded separately, after the rollback (§4-10).
    expect(markedFailed).toEqual({ reservation: "res-42", code: "CONFLICT" });
    expect(failureRecorded).toBe("CONFLICT");
  });

  it("maps an output-schema mismatch to CoreInvariantError and rolls back — never a client validation error", async () => {
    const badOutputContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.returnGarbage",
      description: "Returns output violating its own schema.",
      principal: "staff",
      input: z.object({ id: z.uuid() }),
      output: z.object({ id: z.uuid() }),
      permissions: ["pipelineFixture:write"],
      risk: "write",
      audit: true,
      timeout: 5_000,
    });
    const returnGarbage = implementAction(badOutputContract, {
      handler: async (input, ctx) => {
        await requireWritable(ctx.db).insert(fixtureProducts).values({
          id: input.id,
          companyId: ctx.companyId,
          name: "Garbage output",
          published: false,
        });
        // A string, so it compiles — but not a UUID, so validation fails.
        return { id: "not-a-uuid" };
      },
      auditTarget: () => ({ type: "fixture-product", id: "garbage" }),
    });

    const productId = randomUUID();
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: returnGarbage,
        input: { id: productId },
        request: requestMeta(),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error.code).toBe("INTERNAL");
    // Client-facing message carries no schema details.
    expect(error.clientMessage).toBe("Internal error.");
    expect(await productExists(productId)).toBe(false);
  });

  it("wraps a throw outside the typed error vocabulary as CoreInvariantError", async () => {
    const throwsPlainContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.throwPlain",
      description: "Throws a plain Error to prove vocabulary enforcement.",
      principal: "staff",
      input: z.object({}),
      output: z.object({}),
      permissions: ["pipelineFixture:read"],
      risk: "read",
      audit: false,
      timeout: 5_000,
    });
    const throwsPlain = implementAction(throwsPlainContract, {
      handler: () => Promise.reject(new Error("boom")),
    });

    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: throwsPlain,
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
    expect((error.cause as Error).message).toBe("boom");
  });
});

describe("risk: read — read-only enforcement", () => {
  const auditedReadContract = defineActionContract({
    ...contractDefaults,
    name: "pipelineFixture.readProducts",
    description: "Read fixture products (audited read fixture).",
    principal: "staff",
    input: z.object({}),
    output: z.object({ count: z.number().int() }),
    permissions: ["pipelineFixture:read"],
    risk: "read",
    audit: true,
    timeout: 5_000,
  });

  it("hands the handler the ReadTx capability — no mutation members exist", async () => {
    let capabilityKeys: string[] = [];
    const readProducts = implementAction(auditedReadContract, {
      handler: async (_input, ctx) => {
        capabilityKeys = Object.keys(ctx.db).sort();
        const rows = await ctx.db.select().from(fixtureProducts);
        return { count: rows.length };
      },
      auditTarget: () => ({ type: "fixture-product", id: "read" }),
    });
    // Type level: the read capability cannot compile a mutation.
    expectTypeOf<ReadTx>().not.toHaveProperty("insert");
    expectTypeOf<ReadTx>().not.toHaveProperty("update");
    expectTypeOf<ReadTx>().not.toHaveProperty("delete");
    expectTypeOf<ReadTx>().not.toHaveProperty("execute");

    const hooks: PipelineHooks = {
      audit: {
        recordSuccess: () => Promise.resolve(),
        recordFailure: () => Promise.resolve(),
      },
    };
    const output = await executeAction(depsFor({ hooks }), {
      action: readProducts,
      input: {},
      request: requestMeta(),
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });
    expect(output.count).toBeGreaterThanOrEqual(0);
    expect(capabilityKeys).toEqual([
      "$count",
      "select",
      "selectDistinct",
      "selectDistinctOn",
    ]);
  });

  it("the handler transaction is database read-only — ReadTx facade has no write members", async () => {
    let escapedCapability: Record<string, unknown> = {};
    const readProducts = implementAction(auditedReadContract, {
      handler: (_, ctx) => {
        escapedCapability = ctx.db as Record<string, unknown>;
        return Promise.resolve({ count: 0 });
      },
      auditTarget: () => ({ type: "fixture-product", id: "read" }),
    });
    await executeAction(depsFor(), {
      action: readProducts,
      input: {},
      request: requestMeta(),
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });
    for (const dangerous of ["insert", "update", "delete", "execute"]) {
      expect(
        escapedCapability,
        `ReadTx must not expose ${dangerous}`,
      ).not.toHaveProperty(dangerous);
    }
  });

  it("writes the audited-read audit row in a post-commit transaction (core.md §8)", async () => {
    const req = requestMeta();
    const readProducts = implementAction(auditedReadContract, {
      handler: async (_, ctx) => {
        const rows = await ctx.db.select().from(fixtureProducts);
        return { count: rows.length };
      },
      auditTarget: () => ({ type: "fixture-product", id: "read-audit" }),
    });
    let auditTxWritable = false;
    const hooks: PipelineHooks = {
      audit: {
        recordSuccess: (env) => {
          auditTxWritable = "insert" in env.tx;
          return Promise.resolve();
        },
        recordFailure: () => Promise.resolve(),
      },
    };
    await executeAction(depsFor({ hooks }), {
      action: readProducts,
      input: {},
      request: req,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });
    expect(auditTxWritable).toBe(true);
  });
});

describe("deadline enforcement", () => {
  it("throws TimeoutError and fires the shared abort signal when the handler exceeds the budget", async () => {
    let observedSignal: AbortSignal | undefined;
    const slowContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.sleepForever",
      description: "Sleeps past its own deadline.",
      principal: "staff",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      permissions: ["pipelineFixture:read"],
      risk: "read",
      audit: false,
      // Must outlast auth + tx begin on a loaded CI runner. 200ms is enough
      // locally and too tight under `pnpm test` (handler never starts, so
      // `ctx.signal` is never observed).
      timeout: 5_000,
    });
    const handlerSleepMs = 20_000;
    const sleepForever = implementAction(slowContract, {
      handler: async (_input, ctx) => {
        observedSignal = ctx.signal;
        await new Promise((resolve) => setTimeout(resolve, handlerSleepMs));
        return { done: true };
      },
    });

    const startedAt = Date.now();
    await expectCoreError(
      executeAction(depsFor(), {
        action: sleepForever,
        input: {},
        request: requestMeta(),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      TimeoutError,
    );
    // The pipeline gave up at the deadline, not after the full sleep.
    expect(Date.now() - startedAt).toBeLessThan(handlerSleepMs / 2);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(TimeoutError);
  });

  it("sets the transaction-local statement timeout to the remaining budget", async () => {
    const readTimeoutContract = defineActionContract({
      ...contractDefaults,
      name: "pipelineFixture.readTimeoutSetting",
      description: "Reads the transaction-local statement timeout.",
      principal: "staff",
      input: z.object({}),
      output: z.object({ setting: z.string() }),
      permissions: ["pipelineFixture:write"],
      risk: "write",
      audit: true,
      timeout: 5_000,
    });
    const readTimeoutSetting = implementAction(readTimeoutContract, {
      handler: async (_input, ctx) => {
        const result = await requireWritable(ctx.db).execute(
          sql`select current_setting('statement_timeout') as value`,
        );
        return { setting: String(result.rows[0]?.value) };
      },
      auditTarget: () => ({ type: "fixture-product", id: "timeout" }),
    });

    const output = await executeAction(depsFor(), {
      action: readTimeoutSetting,
      input: {},
      request: requestMeta(),
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });
    const timeoutMs = parseStatementTimeout(output.setting);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(5_000);
  });
});

describe("idempotency slot (§4 step 6)", () => {
  it("replays the stored response without re-running the handler", async () => {
    const storedId = randomUUID();
    let handlerRuns = 0;
    const replayingHooks: PipelineHooks = {
      idempotency: {
        probe: () => Promise.resolve({ kind: "fresh" as const }),
        reserve: () =>
          Promise.resolve({
            kind: "replay" as const,
            response: { id: storedId },
          }),
        finalize: () =>
          Promise.reject(new Error("finalize must not run on replay")),
        markFailed: () =>
          Promise.reject(new Error("markFailed must not run on replay")),
      },
    };
    const countingCreate = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "pipelineFixture.createCounted",
        description: "Counts handler executions for replay tests.",
        principal: "staff",
        input: z.object({ name: z.string().min(1) }),
        output: z.object({ id: z.uuid() }),
        permissions: ["pipelineFixture:write"],
        risk: "write",
        idempotent: true,
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: () => {
          handlerRuns += 1;
          return Promise.resolve({ id: randomUUID() });
        },
        auditTarget: () => ({ type: "fixture-product", id: "counted" }),
      },
    );

    const output = await executeAction(depsFor({ hooks: replayingHooks }), {
      action: countingCreate,
      input: { name: "Replayed" },
      request: requestMeta({ idempotencyKey: randomUUID() }),
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });
    expect(output).toEqual({ id: storedId });
    expect(handlerRuns).toBe(0);
  });

  it("treats a corrupted stored snapshot as a server bug, not client data", async () => {
    const corruptHooks: PipelineHooks = {
      idempotency: {
        probe: () => Promise.resolve({ kind: "fresh" as const }),
        reserve: () =>
          Promise.resolve({
            kind: "replay" as const,
            response: { id: "not-a-uuid" },
          }),
        finalize: () => Promise.resolve(),
        markFailed: () => Promise.resolve(),
      },
    };
    await expectCoreError(
      invokeCreateProduct({
        input: { id: randomUUID(), name: "Corrupt replay" },
        deps: depsFor({ hooks: corruptHooks }),
      }),
      CoreInvariantError,
    );
  });
});

describe("public-global, consumer, and account paths", () => {
  const discoverContract = defineActionContract({
    ...contractDefaults,
    name: "pipelineFixture.discoverProducts",
    description: "Anonymous global discovery over the fixture grant.",
    principal: "public",
    transport: "client",
    publicScope: "globalProjection",
    projectionGrant: "fixture.discovery",
    input: z.object({}),
    output: z.array(
      z.object({
        productId: z.uuid(),
        name: z.string(),
        likeCount: z.number(),
      }),
    ),
    permissions: [],
    risk: "read",
    audit: false,
    timeout: 5_000,
  });
  const discoverProducts = implementAction(discoverContract, {
    handler: async (_input, ctx) => {
      if (ctx.scope !== "globalProjection") {
        throw new CoreInvariantError("fixture expects a public-global context");
      }
      const rows = await ctx.db.from("discoveryProducts");
      return rows.map((row) => ({
        productId: String(row.productId),
        name: String(row.name),
        likeCount: Number(row.likeCount),
      }));
    },
  });

  it("binds a public-global action to its declared grant from the manifest", async () => {
    const output = await executeAction(
      depsFor({
        projectionGrants: createProjectionGrantManifest([
          fixtureDiscoveryGrant,
        ]),
      }),
      {
        action: discoverProducts,
        input: {},
        request: requestMeta(),
        principal: { mode: "public" },
      },
    );
    expect(output).toEqual([
      {
        productId: parityIds.products.published,
        name: "Honey cake",
        likeCount: 1,
      },
    ]);
  });

  it("treats a grant missing from the manifest as a core invariant violation", async () => {
    // The default runtime manifest is empty until projection owners exist.
    await expectCoreError(
      executeAction(depsFor(), {
        action: discoverProducts,
        input: {},
        request: requestMeta(),
        principal: { mode: "public" },
      }),
      CoreInvariantError,
    );
  });

  it("runs consumer reads and account writes without any company scope", async () => {
    const consumerBrowse = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "pipelineFixture.browseDiscovery",
        description: "Authenticated discovery read.",
        principal: "consumer",
        transport: "client",
        input: z.object({}),
        output: z.object({ count: z.number().int() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          const rows = await ctx.db.select().from(fixtureDiscoveryProducts);
          return { count: rows.length };
        },
      },
    );
    const consumerOutput = await executeAction(depsFor(), {
      action: consumerBrowse,
      input: {},
      request: requestMeta(),
      principal: { mode: "consumer", session: { userId: users.anna } },
    });
    expect(consumerOutput.count).toBe(1);

    let accountCompanyId: string | undefined | null;
    const accountTouch = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "pipelineFixture.touchOwnAccount",
        description: "Own-account write without tenant scope.",
        principal: "account",
        transport: "client",
        input: z.object({}),
        output: z.object({ userId: z.string() }),
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => {
          accountCompanyId = ctx.companyId;
          // The account mode carries the writable capability for its risk.
          requireWritable(ctx.db);
          return Promise.resolve({ userId: ctx.userId });
        },
        auditTarget: () => ({ type: "account", id: "self" }),
      },
    );
    const accountOutput = await executeAction(depsFor(), {
      action: accountTouch,
      input: {},
      request: requestMeta(),
      principal: { mode: "account", session: { userId: users.boris } },
    });
    expect(accountOutput).toEqual({ userId: users.boris });
    expect(accountCompanyId).toBeUndefined();
  });
});

describe("structured logs and telemetry", () => {
  it("emits one start and one finish line with the §4 fields", async () => {
    const { logger, entries } = captureLogger();
    const productId = randomUUID();
    await invokeCreateProduct({
      input: { id: productId, name: "Logged" },
      deps: depsFor({ logger }),
    });

    const lines = entries();
    const started = lines.find((line) => line["msg"] === "action started");
    const finished = lines.find((line) => line["msg"] === "action finished");
    expect(started).toMatchObject({
      action: "pipelineFixture.createProduct",
      channel: "ui",
    });
    expect(typeof started?.["request_id"]).toBe("string");
    // Identity is unknown pre-authentication (core.md §4).
    expect(started).not.toHaveProperty("actor_id");
    expect(started).not.toHaveProperty("actor_type");
    expect(started).not.toHaveProperty("company_id");
    expect(started).not.toHaveProperty("outcome");
    expect(finished).toMatchObject({
      action: "pipelineFixture.createProduct",
      actor_type: "user",
      actor_id: users.anna,
      company_id: companyA,
      outcome: "ok",
    });
    expect(typeof finished?.["duration_ms"]).toBe("number");
    // Raw IPs stay transport-only (security-operations §6).
    expect(started).not.toHaveProperty("client_ip");
    expect(finished).not.toHaveProperty("client_ip");
  });

  it("logs the denial outcome with the identity evidence it had", async () => {
    const { logger, entries } = captureLogger();
    await expectCoreError(
      invokeCreateProduct({
        input: { id: randomUUID(), name: "Denied" },
        deps: depsFor({ logger }),
        userId: users.boris,
        companySelector: companyB,
      }),
      PermissionDeniedError,
    );
    const finished = entries().find(
      (line) => line["msg"] === "action finished",
    );
    expect(finished).toMatchObject({
      actor_type: "user",
      actor_id: users.boris,
      outcome: "PERMISSION_DENIED",
    });
  });

  it("opens one span per invocation and records errors with correlation fields", async () => {
    const { telemetry, spans } = recordingTelemetry();
    const okId = randomUUID();
    await invokeCreateProduct({
      input: { id: okId, name: "Traced" },
      deps: depsFor({ telemetry }),
    });
    await expectCoreError(
      invokeCreateProduct({
        input: {
          id: randomUUID(),
          name: "Traced failure",
          failAfterInsert: true,
        },
        deps: depsFor({ telemetry }),
      }),
      ConflictError,
    );

    expect(spans).toHaveLength(2);
    const [okSpan, failedSpan] = spans;
    expect(okSpan?.fields.action).toBe("pipelineFixture.createProduct");
    expect(okSpan?.outcome).toMatchObject({
      outcome: "ok",
      actorId: users.anna,
      companyId: companyA,
    });
    expect(okSpan?.errors).toHaveLength(0);
    expect(failedSpan?.outcome).toMatchObject({ outcome: "CONFLICT" });
    expect(failedSpan?.errors).toHaveLength(1);
    expect(failedSpan?.errors[0]).toBeInstanceOf(ConflictError);
  });
});

describe("protocol hooks fail closed when missing (core.md §5/§7/§8/§10)", () => {
  it("does not execute a non-system action without a rate-limit hook", async () => {
    let ran = 0;
    const action = implementAction(createProductContract, {
      handler: (input) => {
        ran += 1;
        return Promise.resolve({ id: input.id });
      },
      auditTarget: () => ({
        type: "fixture-product",
        id: "missing-rate-limit",
      }),
    });
    await expectCoreError(
      executeAction(depsFor({ hooks: { rateLimit: undefined } }), {
        action,
        input: { id: randomUUID(), name: "No rate limit" },
        request: requestMeta(),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(ran).toBe(0);
  });

  it("does not execute an idempotent mutation without an idempotency hook", async () => {
    let ran = 0;
    const action = implementAction(createProductContract, {
      handler: (input) => {
        ran += 1;
        return Promise.resolve({ id: input.id });
      },
      auditTarget: () => ({
        type: "fixture-product",
        id: "missing-idempotency",
      }),
    });
    await expectCoreError(
      executeAction(depsFor({ hooks: { idempotency: undefined } }), {
        action,
        input: { id: randomUUID(), name: "No idempotency" },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(ran).toBe(0);
  });

  it("does not execute an audited action without an audit hook", async () => {
    let ran = 0;
    const action = implementAction(createProductContract, {
      handler: (input) => {
        ran += 1;
        return Promise.resolve({ id: input.id });
      },
      auditTarget: () => ({ type: "fixture-product", id: "missing-audit" }),
    });
    await expectCoreError(
      executeAction(depsFor({ hooks: { audit: undefined } }), {
        action,
        input: { id: randomUUID(), name: "No audit" },
        request: requestMeta({ idempotencyKey: randomUUID() }),
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
      CoreInvariantError,
    );
    expect(ran).toBe(0);
  });

  it("does not execute a confirmed action without a confirmation hook", async () => {
    let ran = 0;
    const action = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "pipelineFixture.confirmMissingHook",
        description: "High-risk fixture proving confirmation fail-closed.",
        principal: "staff",
        transport: "client",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permissions: ["pipelineFixture:write"],
        risk: "high",
        requiresConfirmation: true,
        idempotent: true,
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: () => {
          ran += 1;
          return Promise.resolve({ ok: true });
        },
        confirmationSummary: () => "Confirm the missing-hook fixture.",
        auditTarget: () => ({ type: "fixture-product", id: "missing-confirm" }),
      },
    );
    await expectCoreError(
      executeAction(depsFor({ hooks: { confirmation: undefined } }), {
        action,
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
    expect(ran).toBe(0);
  });
});
