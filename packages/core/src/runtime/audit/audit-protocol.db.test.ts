/**
 * Integration tests for the audit protocol (fnd-T13 — core.md §8) against
 * the shared Testcontainers harness.
 *
 * Verifies:
 * - Successful write audit row: exact field mapping, hash-only default.
 * - Redacted snapshot opt-in via `auditSnapshot`.
 * - Permission denial recorded without a handler transaction.
 * - Failures before successful input validation write no audit row.
 * - Typed error outcome recorded in the failure path.
 * - AI channel fields preserved with initiating user as actor.
 * - Rollback of the same-tx audit row when a later pipeline step fails.
 * - Audited reads use a post-commit transaction (core.md §8).
 */
import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { eq } from "drizzle-orm";
import { pino, type Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConflictError,
  CoreInvariantError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/index.js";
import { implementAction } from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineHooks,
  PipelineRequestMeta,
} from "../pipeline/types.js";
import { createAuditHook } from "./create-audit-hook.js";

let database: TestDatabase;

const users = {
  anna: "user_anna_audit",
  boris: "user_boris_audit",
} as const;
const companyA = randomUUID();

const silentLogger = pino({ enabled: false });

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

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db.insert(user).values([
    { id: users.anna, name: "Anna", email: "anna-audit@example.test" },
    { id: users.boris, name: "Boris", email: "boris-audit@example.test" },
  ]);
  await database.runtime.db
    .insert(companies)
    .values([
      { id: companyA, name: "Audit Co", slug: "audit-co", prefix: "AU" },
    ]);
  await database.runtime.db.insert(rolePermissionDefaults).values([
    { role: "owner", permission: "audit:write" },
    { role: "owner", permission: "audit:read" },
  ]);
  await database.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: companyA,
      userId: users.boris,
      role: "employee",
      permissions: { granted: [], denied: [] },
    },
  ]);
});

afterAll(async () => {
  await database.close();
});

const contractDefaults = {
  transport: "internal",
  aiExposure: "internal",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
} as const;

function requestMeta(
  overrides: Partial<PipelineRequestMeta> = {},
): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: "203.0.113.7",
    ...overrides,
  };
}

function depsWithAudit(
  overrides: Partial<ActionPipelineDeps> = {},
): ActionPipelineDeps {
  const hooks: PipelineHooks = {
    rateLimit: { enforce: () => Promise.resolve() },
    audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
    ...overrides.hooks,
  };
  return {
    db: database.runtime.db,
    logger: silentLogger,
    ...overrides,
    hooks,
  };
}

async function auditRows(
  requestId: string,
): Promise<(typeof auditLog.$inferSelect)[]> {
  return database.runtime.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.requestId, requestId));
}

// --- Fixture actions ---------------------------------------------------------

const writeContract = defineActionContract({
  ...contractDefaults,
  name: "auditFixture.create",
  description: "Audited write fixture.",
  principal: "staff",
  input: z.object({ orderId: z.uuid(), note: z.string() }),
  output: z.object({ id: z.uuid() }),
  permissions: ["audit:write"],
  risk: "write",
  audit: true,
  timeout: 5_000,
});

const readContract = defineActionContract({
  ...contractDefaults,
  name: "auditFixture.read",
  description: "Audited read fixture.",
  principal: "staff",
  input: z.object({}),
  output: z.object({ count: z.number().int() }),
  permissions: ["audit:read"],
  risk: "read",
  audit: true,
  timeout: 5_000,
});

// --- Tests -------------------------------------------------------------------

describe("audit protocol — success path (core.md §8)", () => {
  it("writes the exact audit_log field set for a successful write", async () => {
    const orderId = randomUUID();
    const req = requestMeta();

    const action = implementAction(writeContract, {
      handler: () => Promise.resolve({ id: orderId }),
      auditTarget: (env) => ({
        type: "order",
        id: (env.input as { orderId: string }).orderId,
      }),
    });

    await executeAction(depsWithAudit(), {
      action,
      input: { orderId, note: "Test note" },
      request: req,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });

    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row).toBeDefined();
    expect(row?.requestId).toBe(req.requestId);
    expect(row?.correlationId).toBe(req.correlationId);
    expect(row?.action).toBe("auditFixture.create");
    expect(row?.actorType).toBe("user");
    expect(row?.actorId).toBe(users.anna);
    expect(row?.channel).toBe("ui");
    expect(row?.companyId).toBe(companyA);
    expect(row?.targetType).toBe("order");
    expect(row?.targetId).toBe(orderId);
    expect(row?.outcome).toBe("ok");
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.inputSnapshot).toBeNull();
    expect(row?.aiTraceId).toBeNull();
    expect(row?.toolCallId).toBeNull();
  });

  it("stores the redacted snapshot when auditSnapshot is bound", async () => {
    const orderId = randomUUID();
    const req = requestMeta();

    const action = implementAction(writeContract, {
      handler: () => Promise.resolve({ id: orderId }),
      auditTarget: () => ({ type: "order", id: orderId }),
      auditSnapshot: (input) => ({ orderId: input.orderId }),
    });

    await executeAction(depsWithAudit(), {
      action,
      input: { orderId, note: "Sensitive content" },
      request: req,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });

    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputSnapshot).toEqual({ orderId });
  });

  it("captures AI channel fields with initiating user as actor", async () => {
    const orderId = randomUUID();
    const req = requestMeta({
      channel: "ai",
      aiTraceId: "trace-abc",
      toolCallId: "call-xyz",
    });

    const action = implementAction(writeContract, {
      handler: () => Promise.resolve({ id: orderId }),
      auditTarget: () => ({ type: "order", id: orderId }),
    });

    await executeAction(depsWithAudit(), {
      action,
      input: { orderId, note: "AI invoked" },
      request: req,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });

    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorType).toBe("user");
    expect(row?.actorId).toBe(users.anna);
    expect(row?.channel).toBe("ai");
    expect(row?.aiTraceId).toBe("trace-abc");
    expect(row?.toolCallId).toBe("call-xyz");
  });
});

describe("audit protocol — failure and denial paths", () => {
  it("records a typed error outcome after handler failure", async () => {
    const orderId = randomUUID();
    const req = requestMeta();

    const action = implementAction(writeContract, {
      handler: () =>
        Promise.reject(new ConflictError("Order already confirmed.")),
      auditTarget: (env) => ({
        type: "order",
        id: (env.input as { orderId: string }).orderId,
      }),
    });

    await expect(
      executeAction(depsWithAudit(), {
        action,
        input: { orderId, note: "Will fail" },
        request: req,
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
    ).rejects.toThrow(ConflictError);

    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("CONFLICT");
    expect(rows[0]?.actorType).toBe("user");
    expect(rows[0]?.actorId).toBe(users.anna);
  });

  it("records PERMISSION_DENIED without a handler transaction", async () => {
    const req = requestMeta();

    const action = implementAction(writeContract, {
      handler: () => Promise.resolve({ id: randomUUID() }),
      auditTarget: (env) => ({
        type: "order",
        id: (env.input as { orderId: string }).orderId,
      }),
    });

    await expect(
      executeAction(depsWithAudit(), {
        action,
        input: { orderId: randomUUID(), note: "No perm" },
        request: req,
        principal: {
          mode: "staff",
          session: { userId: users.boris },
          companySelector: companyA,
        },
      }),
    ).rejects.toThrow(PermissionDeniedError);

    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("PERMISSION_DENIED");
    expect(rows[0]?.actorType).toBe("user");
    expect(rows[0]?.actorId).toBe(users.boris);
  });

  it("writes no audit row when input validation fails (core.md §8)", async () => {
    const req = requestMeta();

    const action = implementAction(writeContract, {
      handler: () => Promise.resolve({ id: randomUUID() }),
      auditTarget: () => ({ type: "order", id: randomUUID() }),
    });

    await expect(
      executeAction(depsWithAudit(), {
        action,
        input: { orderId: "not-a-uuid", note: "bad" },
        request: req,
        principal: {
          mode: "staff",
          session: { userId: users.anna },
          companySelector: companyA,
        },
      }),
    ).rejects.toThrow(ValidationError);

    expect(await auditRows(req.requestId)).toHaveLength(0);
  });
});

describe("audit protocol — transactionality", () => {
  it("rolls back the same-tx audit row when a later pipeline step fails", async () => {
    const orderId = randomUUID();
    const req = requestMeta();

    const hooks: PipelineHooks = {
      audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
      idempotency: {
        probe: () => Promise.resolve({ kind: "fresh" as const }),
        reserve: () => Promise.resolve({ kind: "execute", reservation: "r" }),
        finalize: () =>
          Promise.reject(new CoreInvariantError("finalize failure")),
        markFailed: () => Promise.resolve(),
      },
    };

    const failingContract = defineActionContract({
      ...contractDefaults,
      name: "auditFixture.createIdempotent",
      description: "Audited idempotent write that fails at finalize.",
      principal: "staff",
      input: z.object({ orderId: z.uuid(), note: z.string() }),
      output: z.object({ id: z.uuid() }),
      permissions: ["audit:write"],
      risk: "write",
      idempotent: true,
      audit: true,
      timeout: 5_000,
    });

    const failingAction = implementAction(failingContract, {
      handler: () => Promise.resolve({ id: orderId }),
      auditTarget: () => ({ type: "order", id: orderId }),
    });

    await expect(
      executeAction(
        { db: database.runtime.db, logger: silentLogger, hooks },
        {
          action: failingAction,
          input: { orderId, note: "Will rollback" },
          request: req,
          principal: {
            mode: "staff",
            session: { userId: users.anna },
            companySelector: companyA,
          },
        },
      ),
    ).rejects.toThrow(CoreInvariantError);

    // The entire execution transaction rolled back — including the audit row.
    const rows = await auditRows(req.requestId);
    // Only the failure-path audit row should exist (from recordFailure).
    expect(rows.every((r) => r.outcome !== "ok")).toBe(true);
  });

  it("writes the audited-read row post-commit without blocking the response", async () => {
    const req = requestMeta();

    const action = implementAction(readContract, {
      handler: () => Promise.resolve({ count: 42 }),
      auditTarget: () => ({ type: "read-probe", id: "all" }),
    });

    const result = await executeAction(depsWithAudit(), {
      action,
      input: {},
      request: req,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
    });

    expect(result.count).toBe(42);
    const rows = await auditRows(req.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.action).toBe("auditFixture.read");
  });

  it("logs at error level and falls back to a synthetic target when auditTarget fails during failure recording", async () => {
    const { logger, entries } = captureLogger();
    const hook = createAuditHook({ db: database.runtime.db, logger });
    const request = { ...requestMeta(), action: writeContract.name };

    await hook.recordFailure({
      contract: writeContract,
      request,
      principal: {
        mode: "staff",
        session: { userId: users.anna },
        companySelector: companyA,
      },
      input: { orderId: randomUUID(), note: "broken target builder" },
      error: new ConflictError("unused"),
      authorization: {
        actor: { type: "user", id: users.anna },
        companyId: companyA,
      },
      durationMs: 1,
      auditTarget: () => {
        throw new Error("target builder exploded");
      },
    });

    // The audit row is still written, with the synthetic fallback target.
    const rows = await auditRows(request.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetType).toBe("unknown");
    expect(rows[0]?.targetId).toBe("unknown");
    expect(rows[0]?.outcome).toBe("CONFLICT");

    // The broken auditTarget builder is visible in the logs.
    const errorLogs = entries().filter((entry) => entry.level === 50);
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]?.action).toBe(writeContract.name);
    expect(errorLogs[0]?.request_id).toBe(request.requestId);
  });

  it("refuses to write an audit row for an anonymous actor", async () => {
    const hook = createAuditHook({
      db: database.runtime.db,
      logger: silentLogger,
    });
    await expect(
      hook.recordFailure({
        contract: writeContract,
        request: { ...requestMeta(), action: writeContract.name },
        principal: { mode: "public" },
        input: { orderId: randomUUID(), note: "anonymous" },
        error: new ConflictError("unused"),
        authorization: {
          actor: { type: "anonymous", id: "anonymous" },
          companyId: null,
        },
        durationMs: 1,
        auditTarget: () => ({ type: "order", id: randomUUID() }),
      }),
    ).rejects.toThrow(CoreInvariantError);
  });
});
