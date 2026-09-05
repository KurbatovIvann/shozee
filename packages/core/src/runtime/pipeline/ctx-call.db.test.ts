/**
 * Integration tests for `ctx.call` (fnd-T19 — core.md §9, ADR-0015)
 * against the shared Testcontainers harness:
 *
 * - transaction sharing: the callee sees the caller's uncommitted writes,
 *   but only through the `ReadTx` facade even in a writable caller tx;
 * - runtime target rules: write callees, same-module targets, and
 *   public-global on either side are rejected as `CoreInvariantError`;
 * - defense in depth: the callee's declared permissions re-check (denial
 *   propagates and rolls the caller back) and customer nested resolvers
 *   receive the caller's verified `inheritedCompanyId` (a company
 *   mismatch is a `CoreInvariantError`);
 * - principal compatibility: consumer callers cannot reach company-scoped
 *   callees; account callers may invoke consumer reads; share callers
 *   may invoke only share reads; system scope propagates (tenant →
 *   tenant/global, global → global only);
 * - depth limit 3 and cycle detection by action name;
 * - callee input/output validation, the escaped-context guard, nested
 *   logs/spans, and the audited-callee child audit entry.
 */
import { createHash, randomUUID } from "node:crypto";

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
import { and, eq } from "drizzle-orm";
import { pino, type Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  CoreError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import type { ActionCtx } from "../context/types.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import type { ResolvedTarget, TargetResolutionEnv } from "../types.js";
import { executeAction } from "./execute-action.js";
import type {
  ActionPipelineDeps,
  ActionSpanFields,
  ActionSpanOutcome,
  ActionTelemetry,
  PipelineHooks,
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
    { id: users.anna, name: "Anna", email: "anna@ctx-call.test" },
    { id: users.boris, name: "Boris", email: "boris@ctx-call.test" },
  ]);
  await db.runtime.db.insert(companies).values([
    { id: companyA, name: "Company A", slug: "ctx-call-a", prefix: "XA" },
    { id: companyB, name: "Company B", slug: "ctx-call-b", prefix: "XB" },
  ]);
  // Boris (manager) may run the caller fixture but lacks the callee's
  // declared permission — the denial-propagation case. Anna is owner-all.
  await db.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "manager", permission: "ctxCaller:invoke" }]);
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
    clientIp: "203.0.113.7",
    ...overrides,
  };
}

function depsFor(
  overrides: Partial<ActionPipelineDeps> = {},
): ActionPipelineDeps {
  return {
    db: db.runtime.db,
    logger: silentLogger,
    ...overrides,
    hooks: {
      rateLimit: { enforce: () => Promise.resolve() },
      audit: createAuditHook({ db: db.runtime.db, logger: silentLogger }),
      ...overrides.hooks,
    },
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

async function productExists(id: string): Promise<boolean> {
  const rows = await db.runtime.db
    .select({ id: fixtureProducts.id })
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, id));
  return rows.length > 0;
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

/** Observations the callee fixtures record about their own context. */
const observed = {
  calleeDbKeys: [] as string[],
  calleeCompanyId: undefined as string | null | undefined,
};

/** The staff read callee — the canonical cross-module facts target. */
const getProductFacts = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "ctxCallee.getProductFacts",
    description: "Company-scoped fixture product existence facts.",
    principal: "staff",
    input: z.object({ productId: z.uuid() }),
    output: z.object({ found: z.boolean() }),
    permissions: ["ctxCallee:facts"],
    risk: "read",
    audit: false,
    timeout: 5_000,
  }),
  {
    handler: async (input, ctx) => {
      observed.calleeDbKeys = Object.keys(ctx.db).sort();
      observed.calleeCompanyId = ctx.companyId;
      const rows = await ctx.db
        .select({ id: fixtureProducts.id })
        .from(fixtureProducts)
        .where(
          and(
            eq(fixtureProducts.id, input.productId),
            eq(fixtureProducts.companyId, ctx.companyId),
          ),
        );
      return { found: rows.length > 0 };
    },
  },
);

/** The staff write caller — inserts, then composes the read callee. */
const createAndCheck = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "ctxCaller.createAndCheck",
    description: "Insert a fixture product and read it back via ctx.call.",
    principal: "staff",
    input: z.object({ productId: z.uuid(), name: z.string().min(1) }),
    output: z.object({ found: z.boolean() }),
    permissions: ["ctxCaller:invoke"],
    risk: "write",
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (input, ctx) => {
      await requireWritable(ctx.db).insert(fixtureProducts).values({
        id: input.productId,
        companyId: ctx.companyId,
        name: input.name,
        published: false,
      });
      return await ctx.call(getProductFacts, { productId: input.productId });
    },
    auditTarget: () => ({ type: "fixture-product", id: "ctx-call" }),
  },
);

function invokeCreateAndCheck(options: {
  readonly input: unknown;
  readonly deps?: ActionPipelineDeps;
  readonly userId?: string;
  readonly companySelector?: string;
  readonly request?: Partial<PipelineRequestMeta>;
}) {
  return executeAction(options.deps ?? depsFor(), {
    action: createAndCheck,
    input: options.input,
    request: requestMeta(options.request),
    principal: {
      mode: "staff",
      session: { userId: options.userId ?? users.anna },
      companySelector: options.companySelector ?? companyA,
    },
  });
}

/** Runs one throwaway staff-read root action around `run`. */
function staffReadRoot(
  name: string,
  run: (ctx: ActionCtx) => Promise<unknown>,
  deps?: ActionPipelineDeps,
): Promise<unknown> {
  const action = implementAction(
    defineActionContract({
      ...contractDefaults,
      name,
      description: "Throwaway staff read root for ctx.call tests.",
      principal: "staff",
      input: z.object({}),
      output: z.unknown(),
      permissions: ["ctxCaller:invoke"],
      risk: "read",
      audit: false,
      timeout: 5_000,
    }),
    { handler: (_input, ctx) => run(ctx).then((value) => value ?? null) },
  );
  return executeAction(deps ?? depsFor(), {
    action,
    input: {},
    request: requestMeta(),
    principal: {
      mode: "staff",
      session: { userId: users.anna },
      companySelector: companyA,
    },
  });
}

// --- Target rules ------------------------------------------------------------

describe("runtime target rules (core.md §9)", () => {
  it("shares the caller's transaction and hands the callee the ReadTx facade", async () => {
    const productId = randomUUID();
    const output = await invokeCreateAndCheck({
      input: { productId, name: "Uncommitted" },
    });
    // The callee saw the caller's uncommitted insert — same transaction.
    expect(output).toEqual({ found: true });
    // …but only through the read facade, despite the writable caller tx.
    expect(observed.calleeDbKeys).toEqual([
      "$count",
      "select",
      "selectDistinct",
      "selectDistinctOn",
    ]);
    // The callee re-authorized in the caller's verified company.
    expect(observed.calleeCompanyId).toBe(companyA);
    expect(await productExists(productId)).toBe(true);
  });

  it("rejects a write callee at runtime as a CoreInvariantError", async () => {
    let calleeRan = 0;
    const writeCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCallee.mutateThing",
        description: "Write action that must never be callable.",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["ctxCallee:facts"],
        risk: "write",
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: () => {
          calleeRan += 1;
          return Promise.resolve({});
        },
        auditTarget: () => ({ type: "fixture", id: "never" }),
      },
    );

    const error = await expectCoreError(
      staffReadRoot("ctxCaller.callWrite", (ctx) => ctx.call(writeCallee, {})),
      CoreInvariantError,
    );
    expect(error.message).toContain('only risk: "read" actions are callable');
    expect(calleeRan).toBe(0);
  });

  it("rejects a same-module target — composition inside a module uses services/", async () => {
    const sibling = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCaller.readSibling",
        description: "Read action in the caller's own module.",
        principal: "staff",
        input: z.object({}),
        output: z.object({}),
        permissions: ["ctxCaller:invoke"],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      { handler: () => Promise.resolve({}) },
    );

    const error = await expectCoreError(
      staffReadRoot("ctxCaller.callSibling", (ctx) => ctx.call(sibling, {})),
      CoreInvariantError,
    );
    expect(error.message).toContain("same-module composition uses services/");
  });

  it("rejects any ctx.call from a public-global caller", async () => {
    const consumerCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxConsumerCallee.countDiscovery",
        description: "Consumer discovery read used across caller tests.",
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
    const publicGlobalCaller = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxPublicCaller.discover",
        description: "Public-global caller that must not compose.",
        principal: "public",
        transport: "client",
        publicScope: "globalProjection",
        projectionGrant: "fixture.discovery",
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.call(consumerCallee, {});
          return {};
        },
      },
    );

    const error = await expectCoreError(
      executeAction(
        depsFor({
          projectionGrants: createProjectionGrantManifest([
            fixtureDiscoveryGrant,
          ]),
        }),
        {
          action: publicGlobalCaller,
          input: {},
          request: requestMeta(),
          principal: { mode: "public" },
        },
      ),
      CoreInvariantError,
    );
    expect(error.message).toContain(
      "public-global actions cannot use ctx.call",
    );
  });
});

// --- Defense in depth --------------------------------------------------------

describe("callee re-authorization", () => {
  it("propagates the callee's permission denial and rolls the caller back", async () => {
    // Boris (manager of company B) holds "ctxCaller:invoke" via the role
    // default but not the callee's "ctxCallee:facts".
    const productId = randomUUID();
    await expectCoreError(
      invokeCreateAndCheck({
        input: { productId, name: "Denied downstream" },
        userId: users.boris,
        companySelector: companyB,
      }),
      PermissionDeniedError,
    );
    // The caller's own insert rolled back with the failed invocation.
    expect(await productExists(productId)).toBe(false);
  });

  it("re-runs customer resolvers with the caller's verified company (inheritedCompanyId)", async () => {
    let calleeInheritedCompanyId: string | undefined;
    const getNote = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCrmCallee.getNote",
        description: "Customer read over the CRM sentinel fixture.",
        principal: "customer",
        input: z.object({ customerId: z.uuid() }),
        output: z.object({ companyId: z.uuid() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => {
          return Promise.resolve({ companyId: ctx.target.companyId });
        },
        resolveTarget: async (input, env) => {
          calleeInheritedCompanyId = env.inheritedCompanyId;
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
      },
    );
    const readNote = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCrmCaller.readNote",
        description: "Customer caller composing the CRM note read.",
        principal: "customer",
        input: z.object({ customerId: z.uuid() }),
        output: z.object({ companyId: z.uuid() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: (input, ctx) => ctx.call(getNote, input),
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
      },
    );

    const output = await executeAction(depsFor(), {
      action: readNote,
      input: { customerId: parityIds.crmSentinel },
      request: requestMeta(),
      principal: {
        mode: "customer",
        session: { userId: parityIds.users.boris },
      },
    });
    expect(output).toEqual({ companyId: parityIds.companies.published });
    expect(calleeInheritedCompanyId).toBe(parityIds.companies.published);
  });

  it("treats a nested resolver resolving a different company as a CoreInvariantError", async () => {
    const foreignNote = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCrmCallee.getForeignNote",
        description: "Callee whose resolver crosses tenants (a bug).",
        principal: "customer",
        input: z.object({ customerId: z.uuid() }),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: () => Promise.resolve({}),
        resolveTarget: () =>
          Promise.resolve({
            companyId: parityIds.companies.unpublished,
            resource: null,
          }),
      },
    );
    const readForeign = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCrmCaller.readForeign",
        description: "Customer caller hitting the crossing resolver.",
        principal: "customer",
        input: z.object({ customerId: z.uuid() }),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: (input, ctx) => ctx.call(foreignNote, input),
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
      },
    );

    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: readForeign,
        input: { customerId: parityIds.crmSentinel },
        request: requestMeta(),
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

// --- Principal compatibility -------------------------------------------------

describe("principal compatibility", () => {
  const consumerCount = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "ctxConsumerCallee.countProducts",
      description: "Consumer discovery read for compatibility tests.",
      principal: "consumer",
      transport: "client",
      input: z.object({}),
      output: z.object({ count: z.number().int(), companyId: z.null() }),
      permissions: [],
      risk: "read",
      audit: false,
      timeout: 5_000,
    }),
    {
      handler: async (_input, ctx) => {
        // The consumer type forbids a company scope; `null` is what the
        // wire shape reports for "no tenant".
        const rows = await ctx.db.select().from(fixtureDiscoveryProducts);
        return { count: rows.length, companyId: null };
      },
    },
  );

  it("rejects a consumer caller invoking a company-scoped callee", async () => {
    const browse = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxConsumerCaller.browse",
        description: "Consumer caller reaching for staff facts (a bug).",
        principal: "consumer",
        transport: "client",
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.call(getProductFacts, { productId: randomUUID() });
          return {};
        },
      },
    );
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: browse,
        input: {},
        request: requestMeta(),
        principal: { mode: "consumer", session: { userId: users.anna } },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("does not accept the caller's principal");
  });

  it("lets an account caller invoke a consumer discovery read", async () => {
    const checkDiscovery = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxAccountCaller.checkDiscovery",
        description: "Account caller composing a consumer read.",
        principal: "account",
        transport: "client",
        input: z.object({}),
        output: z.object({ count: z.number().int(), companyId: z.null() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      { handler: (_input, ctx) => ctx.call(consumerCount, {}) },
    );
    const output = await executeAction(depsFor(), {
      action: checkDiscovery,
      input: {},
      request: requestMeta(),
      principal: { mode: "account", session: { userId: users.anna } },
    });
    // The callee ran as a consumer context with no company scope at all.
    expect(output).toEqual({ count: 1, companyId: null });
  });

  const shareToken = "ctx-call-share-token";
  const shareDocumentId = randomUUID();

  function resolveShareToken(
    input: { token: string; documentId: string },
    env: TargetResolutionEnv,
  ): Promise<ResolvedTarget<{ documentId: string }>> {
    if (env.principal.mode !== "share") {
      throw new NotFoundError();
    }
    if (input.token !== shareToken || input.documentId !== shareDocumentId) {
      throw new NotFoundError();
    }
    return Promise.resolve({
      companyId: companyA,
      resource: { documentId: input.documentId },
      tokenHash: createHash("sha256").update(input.token).digest("hex"),
    });
  }

  const shareGetFacts = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "ctxShareCallee.getFacts",
      description: "Share-token read callee.",
      principal: "share",
      transport: "client",
      input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
      output: z.object({ companyId: z.uuid() }),
      permissions: [],
      risk: "read",
      audit: false,
      timeout: 5_000,
    }),
    {
      resolveTarget: resolveShareToken,
      handler: (_input, ctx) => {
        return Promise.resolve({ companyId: ctx.target.companyId });
      },
    },
  );

  const publicGetProduct = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "ctxPublicCallee.getProduct",
      description: "Public-target read for share compatibility tests.",
      principal: "public",
      transport: "client",
      publicScope: "target",
      input: z.object({ productId: z.uuid() }),
      output: z.object({ found: z.boolean() }),
      permissions: [],
      risk: "read",
      audit: false,
      timeout: 5_000,
    }),
    {
      resolveTarget: async (input, env) => {
        if (env.principal.mode !== "public") {
          throw new NotFoundError();
        }
        const rows = await env.tx
          .select()
          .from(fixtureProducts)
          .where(
            and(
              eq(fixtureProducts.id, input.productId),
              eq(fixtureProducts.published, true),
            ),
          );
        const row = rows[0];
        if (row === undefined) {
          throw new NotFoundError();
        }
        return { companyId: row.companyId, resource: row };
      },
      handler: () => Promise.resolve({ found: true }),
    },
  );

  it("lets a share caller invoke a share read", async () => {
    const peek = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxShareCaller.peek",
        description: "Share caller composing another share read.",
        principal: "share",
        transport: "client",
        input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
        output: z.object({ companyId: z.uuid() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveShareToken,
        handler: (input, ctx) => ctx.call(shareGetFacts, input),
      },
    );
    const output = await executeAction(depsFor(), {
      action: peek,
      input: { token: shareToken, documentId: shareDocumentId },
      request: requestMeta(),
      principal: { mode: "share" },
    });
    expect(output).toEqual({ companyId: companyA });
  });

  it("rejects a share caller invoking a staff read", async () => {
    const peek = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxShareCaller.staffLeak",
        description: "Share caller reaching for staff facts (a bug).",
        principal: "share",
        transport: "client",
        input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveShareToken,
        handler: async (_input, ctx) => {
          await ctx.call(getProductFacts, { productId: randomUUID() });
          return {};
        },
      },
    );
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: peek,
        input: { token: shareToken, documentId: shareDocumentId },
        request: requestMeta(),
        principal: { mode: "share" },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("does not accept the caller's principal");
  });

  it("rejects a share caller invoking a public-target read", async () => {
    const peek = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxShareCaller.publicLeak",
        description: "Share caller reaching for a public-target read (a bug).",
        principal: "share",
        transport: "client",
        input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveShareToken,
        handler: async (_input, ctx) => {
          await ctx.call(publicGetProduct, { productId: randomUUID() });
          return {};
        },
      },
    );
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: peek,
        input: { token: shareToken, documentId: shareDocumentId },
        request: requestMeta(),
        principal: { mode: "share" },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("does not accept the caller's principal");
  });

  it("propagates system tenant scope and rejects global → tenant calls", async () => {
    const readTenantThing = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxSysCallee.readTenantThing",
        description: "Tenant-scoped system read.",
        principal: "system",
        systemScope: "tenant",
        input: z.object({}),
        output: z.object({ companyId: z.uuid() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => {
          if (ctx.scope !== "tenant") {
            throw new CoreInvariantError("callee expects a tenant system ctx");
          }
          return Promise.resolve({ companyId: ctx.companyId });
        },
      },
    );
    const readGlobalThing = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxSysCallee.readGlobalThing",
        description: "Global system read.",
        principal: "system",
        systemScope: "global",
        input: z.object({}),
        output: z.object({ global: z.boolean() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => {
          if (ctx.scope !== "global") {
            throw new CoreInvariantError("callee expects a global system ctx");
          }
          return Promise.resolve({ global: true });
        },
      },
    );
    const aggregate = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxSysCaller.aggregate",
        description: "Tenant system caller composing tenant + global reads.",
        principal: "system",
        systemScope: "tenant",
        input: z.object({}),
        output: z.object({ companyId: z.uuid(), global: z.boolean() }),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          const tenant = await ctx.call(readTenantThing, {});
          const global = await ctx.call(readGlobalThing, {});
          return { companyId: tenant.companyId, global: global.global };
        },
      },
    );

    const output = await executeAction(depsFor(), {
      action: aggregate,
      input: {},
      request: requestMeta({ channel: "system" }),
      principal: {
        mode: "system",
        serviceName: "ctx-call-fixture",
        scope: { scope: "tenant", companyId: companyA },
      },
    });
    // The tenant callee inherited the caller's explicit company scope.
    expect(output).toEqual({ companyId: companyA, global: true });

    const sweep = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxSysGlobal.sweep",
        description: "Global system caller reaching a tenant read (a bug).",
        principal: "system",
        systemScope: "global",
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.call(readTenantThing, {});
          return {};
        },
      },
    );
    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: sweep,
        input: {},
        request: requestMeta({ channel: "system" }),
        principal: {
          mode: "system",
          serviceName: "ctx-call-fixture",
          scope: { scope: "global" },
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("does not accept the caller's principal");
  });
});

// --- Depth and cycles --------------------------------------------------------

describe("depth limit and cycle detection", () => {
  const stepOutput = z.object({ reached: z.string() });
  const stepInput = z.object({ remaining: z.number().int().min(0) });
  type ChainStep = ImplementedAction<typeof stepInput, typeof stepOutput>;

  function chainStep(module: string, next?: () => ChainStep): ChainStep {
    return implementAction(
      defineActionContract({
        ...contractDefaults,
        name: `${module}.step`,
        description: "One link of the depth-limit chain.",
        principal: "system",
        systemScope: "global",
        input: stepInput,
        output: stepOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          if (input.remaining === 0 || next === undefined) {
            return { reached: module };
          }
          return await ctx.call(next(), { remaining: input.remaining - 1 });
        },
      },
    );
  }

  const stepD = chainStep("ctxChainD");
  const stepC = chainStep("ctxChainC", () => stepD);
  const stepB = chainStep("ctxChainB", () => stepC);
  const stepA = chainStep("ctxChainA", () => stepB);
  const chainRoot = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "ctxChainRoot.run",
      description: "Root of the depth-limit chain.",
      principal: "system",
      systemScope: "global",
      input: stepInput,
      output: stepOutput,
      permissions: [],
      risk: "read",
      audit: false,
      timeout: 5_000,
    }),
    {
      handler: (input, ctx) =>
        ctx.call(stepA, { remaining: input.remaining - 1 }),
    },
  );

  function invokeChain(remaining: number) {
    return executeAction(depsFor(), {
      action: chainRoot,
      input: { remaining },
      request: requestMeta({ channel: "system" }),
      principal: {
        mode: "system",
        serviceName: "ctx-call-fixture",
        scope: { scope: "global" },
      },
    });
  }

  it("allows three nested levels and rejects the fourth", async () => {
    // root → A → B → C: exactly three nested calls below the root.
    await expect(invokeChain(3)).resolves.toEqual({ reached: "ctxChainC" });

    // root → A → B → C → D: the fourth nested call is a bug.
    const error = await expectCoreError(invokeChain(4), CoreInvariantError);
    expect(error.message).toContain("depth limit of 3 exceeded");
    expect(error.message).toContain("ctxChainD.step");
  });

  it("detects a call cycle by action name", async () => {
    // Mutual closures: ping → pong → ping. Initialization order is safe —
    // handlers only dereference at call time.
    const ping = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCycleA.ping",
        description: "First half of the call cycle.",
        principal: "system",
        systemScope: "global",
        input: z.object({ bounce: z.boolean() }),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          if (input.bounce) {
            await ctx.call(pong, {});
          }
          return {};
        },
      },
    );
    const pong = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCycleB.pong",
        description: "Second half of the call cycle.",
        principal: "system",
        systemScope: "global",
        input: z.object({}),
        output: z.object({}),
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          await ctx.call(ping, { bounce: false });
          return {};
        },
      },
    );

    const error = await expectCoreError(
      executeAction(depsFor(), {
        action: ping,
        input: { bounce: true },
        request: requestMeta({ channel: "system" }),
        principal: {
          mode: "system",
          serviceName: "ctx-call-fixture",
          scope: { scope: "global" },
        },
      }),
      CoreInvariantError,
    );
    expect(error.message).toContain("cycle detected");
    expect(error.message).toContain(
      "ctxCycleA.ping → ctxCycleB.pong → ctxCycleA.ping",
    );
  });
});

// --- Validation, escape, observability ---------------------------------------

describe("callee validation and the escaped-context guard", () => {
  it("validates callee input like a transport invocation (ValidationError)", async () => {
    await expectCoreError(
      staffReadRoot("ctxCaller.badInput", (ctx) =>
        ctx.call(getProductFacts, { productId: "not-a-uuid" }),
      ),
      ValidationError,
    );
  });

  it("maps a callee output mismatch to CoreInvariantError", async () => {
    const badOutput = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxCallee.badOutput",
        description: "Read callee violating its own output schema.",
        principal: "staff",
        input: z.object({}),
        output: z.object({ id: z.uuid() }),
        permissions: ["ctxCallee:facts"],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      // A string, so it compiles — but not a UUID, so validation fails.
      { handler: () => Promise.resolve({ id: "not-a-uuid" }) },
    );
    const error = await expectCoreError(
      staffReadRoot("ctxCaller.callBadOutput", (ctx) =>
        ctx.call(badOutput, {}),
      ),
      CoreInvariantError,
    );
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error.message).toContain("failed the declared output schema");
  });

  it("refuses to run from a context that escaped its handler", async () => {
    let leaked: ActionCtx | undefined;
    await staffReadRoot("ctxCaller.leakCtx", (ctx) => {
      leaked = ctx;
      return Promise.resolve({});
    });
    if (leaked === undefined) {
      throw new Error("fixture handler did not run");
    }
    const error = await expectCoreError(
      leaked.call(getProductFacts, { productId: randomUUID() }),
      CoreInvariantError,
    );
    expect(error.message).toContain("outside its handler execution");
  });
});

describe("nested observability and audit", () => {
  it("emits correlation-nested log lines and one span per nested call", async () => {
    const { logger, entries } = captureLogger();
    const { telemetry, spans } = recordingTelemetry();
    const correlationId = randomUUID();
    await invokeCreateAndCheck({
      input: { productId: randomUUID(), name: "Observed" },
      deps: depsFor({ logger, telemetry }),
      request: { correlationId },
    });

    const nestedStart = entries().find(
      (line) => line["msg"] === "nested call started",
    );
    const nestedFinish = entries().find(
      (line) => line["msg"] === "nested call finished",
    );
    expect(nestedStart).toMatchObject({
      action: "ctxCallee.getProductFacts",
      caller_action: "ctxCaller.createAndCheck",
      correlation_id: correlationId,
    });
    expect(nestedFinish).toMatchObject({
      action: "ctxCallee.getProductFacts",
      outcome: "ok",
      actor_id: users.anna,
      company_id: companyA,
    });

    expect(spans).toHaveLength(2);
    const [rootSpan, nestedSpan] = spans;
    expect(rootSpan?.fields.action).toBe("ctxCaller.createAndCheck");
    expect(nestedSpan?.fields).toMatchObject({
      action: "ctxCallee.getProductFacts",
      correlationId,
    });
    expect(nestedSpan?.outcome).toMatchObject({
      outcome: "ok",
      companyId: companyA,
    });
  });

  it("records a child audit entry only for callees that declare audit", async () => {
    const auditedRead = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "ctxAuditedCallee.readAudited",
        description: "Audited read callee.",
        principal: "staff",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permissions: ["ctxCallee:facts"],
        risk: "read",
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: () => Promise.resolve({ ok: true }),
        auditTarget: () => ({ type: "fixture", id: "audited-read" }),
      },
    );

    const recorded: { action: string; txWritable: boolean }[] = [];
    const hooks: PipelineHooks = {
      audit: {
        recordSuccess: (env) => {
          recorded.push({
            action: env.contract.name,
            txWritable: "insert" in env.tx,
          });
          return Promise.resolve();
        },
        recordFailure: () => Promise.resolve(),
      },
    };

    await staffReadRoot(
      "ctxCaller.callAudited",
      (ctx) => ctx.call(auditedRead, {}),
      depsFor({ hooks }),
    );
    // Exactly one child entry — the unaudited root read writes none, and
    // the audited callee's entry lands in a separate writable transaction
    // (§8 audited-read rule).
    expect(recorded).toEqual([
      { action: "ctxAuditedCallee.readAudited", txWritable: true },
    ]);
  });
});
