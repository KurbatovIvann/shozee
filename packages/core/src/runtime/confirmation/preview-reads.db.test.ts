import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConfirmationRequiredError,
  CoreError,
  CoreInvariantError,
  NotFoundError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineRequestMeta,
} from "../pipeline/types.js";
import type { ActionPreviewEnv, ConfirmationSummaryEnv } from "../types.js";
import { createConfirmationHook } from "./create-confirmation-hook.js";
import {
  createInMemoryConfirmationStore,
  type ConfirmationStore,
} from "./store.js";

let database: TestDatabase;

const annaId = "user_anna_preview_reads_db";
const companyA = randomUUID();
const companyB = randomUUID();
const companyAName = "Квіти Анни";
const silentLogger = pino({ enabled: false });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db
    .insert(user)
    .values([{ id: annaId, name: "Anna", email: "anna-preview@example.test" }]);
  await database.runtime.db.insert(companies).values([
    { id: companyA, name: companyAName, slug: "preview-reads-a", prefix: "RA" },
    { id: companyB, name: "Foreign", slug: "preview-reads-b", prefix: "RB" },
  ]);
  await database.runtime.db.insert(rolePermissionDefaults).values([
    { role: "owner", permission: "previewReads:manage" },
    { role: "owner", permission: "previewPeer:read" },
  ]);
  await database.runtime.db.insert(companyMembers).values(
    [companyA, companyB].map((companyId) => ({
      companyId,
      userId: annaId,
      role: "owner" as const,
      permissions: { granted: [], denied: [] },
    })),
  );
});

afterAll(async () => {
  await database.close();
});

const contractDefaults = {
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
} as const;

const renameContract = defineActionContract({
  ...contractDefaults,
  errors: ["NOT_FOUND"],
  name: "previewReads.renameThing",
  description: "Confirmed write whose card resolves the company name.",
  principal: "staff",
  input: z.object({ companyRef: z.uuid(), note: z.string() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["previewReads:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const peerReadContract = defineActionContract({
  ...contractDefaults,
  errors: ["NOT_FOUND"],
  name: "previewPeer.getCompanyName",
  description: "Company-scoped name lookup, callable cross-module.",
  principal: "staff",
  input: z.object({ companyRef: z.uuid() }),
  output: z.object({ name: z.string() }),
  permissions: ["previewPeer:read"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  audit: false,
  timeout: 5_000,
});

const peerAuditedReadContract = defineActionContract({
  ...contractDefaults,
  errors: ["NOT_FOUND"],
  name: "previewPeer.getAuditedCompanyName",
  description: "Company-scoped name lookup that records an audit row.",
  principal: "staff",
  input: z.object({ companyRef: z.uuid() }),
  output: z.object({ name: z.string() }),
  permissions: ["previewPeer:read"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  audit: true,
  timeout: 5_000,
});

const peerWriteContract = defineActionContract({
  ...contractDefaults,
  errors: [],
  name: "previewPeer.touchThing",
  description: "Cross-module write — never a ctx.call target.",
  principal: "staff",
  input: z.object({ companyRef: z.uuid() }),
  output: z.object({ ok: z.boolean() }),
  permissions: ["previewPeer:read"],
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const getCompanyName = implementAction(peerReadContract, {
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select({ name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.id, input.companyRef),
          eq(companies.id, ctx.companyId),
        ),
      );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    return { name: row.name };
  },
});

const getAuditedCompanyName = implementAction(peerAuditedReadContract, {
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select({ name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.id, input.companyRef),
          eq(companies.id, ctx.companyId),
        ),
      );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    return { name: row.name };
  },
  auditTarget: () => ({ type: "company", id: companyA }),
});

const touchThing = implementAction(peerWriteContract, {
  handler: () => Promise.resolve({ ok: true }),
  auditTarget: () => ({ type: "thing", id: "peer" }),
});

type RenameAction = ImplementedAction<
  typeof renameContract.input,
  typeof renameContract.output
>;

function renameAction(
  preview: (
    input: { companyRef: string; note: string },
    env: ActionPreviewEnv,
  ) => Promise<{
    title: string;
    lines: readonly { label: string; value: string }[];
  }>,
): RenameAction {
  return implementAction(renameContract, {
    handler: () => Promise.resolve({ resultId: randomUUID() }),
    preview,
    auditTarget: () => ({ type: "thing", id: "fixture" }),
  });
}

const directReadPreview = renameAction(async (input, env) => {
  const rows = await env.tx
    .select({ name: companies.name })
    .from(companies)
    .where(
      and(
        eq(companies.id, input.companyRef),
        eq(companies.id, env.companyId ?? ""),
      ),
    );
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return {
    title: `Rename ${row.name} to ${input.note}`,
    lines: [{ label: "Current name", value: row.name }],
  };
});

const calledReadPreview = renameAction(async (input, env) => {
  const peer = await env.call(getCompanyName, { companyRef: input.companyRef });
  return {
    title: `Rename ${peer.name} to ${input.note}`,
    lines: [{ label: "Current name", value: peer.name }],
  };
});

const calledAuditedReadPreview = renameAction(async (input, env) => {
  const peer = await env.call(getAuditedCompanyName, {
    companyRef: input.companyRef,
  });
  return {
    title: `Rename ${peer.name} to ${input.note}`,
    lines: [{ label: "Current name", value: peer.name }],
  };
});

let escapedPreviewCall: ActionPreviewEnv["call"] | undefined;

const escapingPreview = renameAction((_input, env) => {
  escapedPreviewCall = env.call;
  return Promise.resolve({ title: "Rename", lines: [] });
});

const calledWritePreview = renameAction(async (input, env) => {
  await env.call(touchThing, { companyRef: input.companyRef });
  return { title: "unreachable", lines: [] };
});

const lockAttemptPreview = renameAction(async (input, env) => {
  await env.tx
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, input.companyRef))
    .for("update");
  return { title: "unreachable", lines: [] };
});

const throwingPreview = renameAction(() => {
  throw new NotFoundError();
});

const slowContract = defineActionContract({
  ...contractDefaults,
  errors: [],
  name: "previewReads.slowThing",
  description: "Confirmed write whose card runs a query past the deadline.",
  principal: "staff",
  input: z.object({ companyRef: z.uuid() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["previewReads:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 2_000,
});

const slowPreviewAction = implementAction(slowContract, {
  handler: () => Promise.resolve({ resultId: randomUUID() }),
  preview: async (_input, env) => {
    await env.tx
      .select({ slept: sql<string>`pg_sleep(10)::text` })
      .from(companies)
      .limit(1);
    return { title: "unreachable", lines: [] };
  },
  auditTarget: () => ({ type: "thing", id: "slow" }),
});

const customerContract = defineActionContract({
  ...contractDefaults,
  transport: "client",
  errors: ["NOT_FOUND"],
  name: "previewReads.customerRename",
  description: "Customer-principal card built from the resolved target.",
  principal: "customer",
  input: z.object({ companyRef: z.uuid() }),
  output: z.object({ companyId: z.uuid() }),
  permissions: [],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const resolverPasses: { readonly name: string; readonly pass: number }[] = [];

function previewPass(target: unknown): number {
  if (
    typeof target === "object" &&
    target !== null &&
    "pass" in target &&
    typeof target.pass === "number"
  ) {
    return target.pass;
  }
  throw new CoreInvariantError("preview target carries no resolver pass");
}

const customerPreviewAction = implementAction(customerContract, {
  handler: (_input, ctx) =>
    Promise.resolve({ companyId: ctx.target.companyId }),
  resolveTarget: async (input, resolveEnv) => {
    if (resolveEnv.principal.mode !== "customer") {
      throw new CoreInvariantError("fixture expects a customer resolver");
    }
    const rows = await resolveEnv.tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .innerJoin(companyMembers, eq(companyMembers.companyId, companies.id))
      .where(
        and(
          eq(companies.id, input.companyRef),
          eq(companyMembers.userId, resolveEnv.principal.userId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    const resource = { name: row.name, pass: resolverPasses.length + 1 };
    resolverPasses.push(resource);
    return { companyId: row.id, resource };
  },
  preview: (_input, env) => ({
    title: "Rename",
    lines: [{ label: "Resolver pass", value: String(previewPass(env.target)) }],
  }),
  auditTarget: () => ({ type: "thing", id: "customer" }),
});

const summaryOnlyAction = implementAction(renameContract, {
  handler: () => Promise.resolve({ resultId: randomUUID() }),
  confirmationSummary: (_input, env: ConfirmationSummaryEnv) =>
    Object.keys(env).sort().join(","),
  auditTarget: () => ({ type: "thing", id: "fixture" }),
});

function causeChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}

function countingStore(): {
  readonly store: ConfirmationStore;
  readonly stored: () => number;
} {
  const inner = createInMemoryConfirmationStore();
  let stored = 0;
  return {
    store: {
      async set(key, value, ttlMs) {
        stored += 1;
        await inner.set(key, value, ttlMs);
      },
      getAndDelete: (key) => inner.getAndDelete(key),
    },
    stored: () => stored,
  };
}

function deps(store: ConfirmationStore): ActionPipelineDeps {
  return {
    db: database.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit: { enforce: () => Promise.resolve() },
      audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
      idempotency: createIdempotencyHook({ db: database.runtime.db }),
      confirmation: createConfirmationHook({ store }),
    },
  };
}

function requestMeta(): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ai",
    idempotencyKey: randomUUID(),
  };
}

async function card(
  action: RenameAction,
  options: { readonly companyRef?: string; readonly store?: ConfirmationStore },
): Promise<unknown> {
  const error = await executeAction(
    deps(options.store ?? createInMemoryConfirmationStore()),
    {
      action,
      input: { companyRef: options.companyRef ?? companyA, note: "Нова назва" },
      request: requestMeta(),
      principal: {
        mode: "staff",
        session: { userId: annaId },
        companySelector: companyA,
      },
    },
  ).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error;
}

describe("preview reads (core.md §7, ADR-0050)", () => {
  it("resolves a same-company record through the preview transaction", async () => {
    const error = await card(directReadPreview, {});
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    const required = error as ConfirmationRequiredError;
    expect(required.challenge.preview?.title).toBe(
      `Rename ${companyAName} to Нова назва`,
    );
    expect(required.challenge.preview?.lines[0]?.value).toBe(companyAName);
  });

  it("resolves a same-company record through a ctx.call read edge", async () => {
    const error = await card(calledReadPreview, {});
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect((error as ConfirmationRequiredError).challenge.preview?.title).toBe(
      `Rename ${companyAName} to Нова назва`,
    );
  });

  it("refuses a foreign id exactly as it refuses a missing one", async () => {
    const foreign = await card(directReadPreview, { companyRef: companyB });
    const missing = await card(directReadPreview, {
      companyRef: randomUUID(),
    });
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((foreign as CoreError).code).toBe((missing as CoreError).code);
    expect((foreign as CoreError).clientMessage).toBe(
      (missing as CoreError).clientMessage,
    );
  });

  it("leaks nothing about a foreign id through the called read either", async () => {
    const foreign = await card(calledReadPreview, { companyRef: companyB });
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect((foreign as CoreError).clientMessage).not.toContain(companyB);
  });

  it("runs the preview in a database read-only transaction", async () => {
    const error = await card(lockAttemptPreview, {});
    expect(error).toBeInstanceOf(CoreInvariantError);
    expect(causeChain(error)).toContain("read-only transaction");
  });

  it("refuses ctx.call of a write action from the preview", async () => {
    const error = await card(calledWritePreview, {});
    expect(error).toBeInstanceOf(CoreInvariantError);
    expect((error as CoreInvariantError).message).toContain(
      'only risk: "read" actions are callable cross-module',
    );
  });

  it("stores no challenge when the preview throws", async () => {
    const counting = countingStore();
    const error = await card(throwingPreview, { store: counting.store });
    expect(error).toBeInstanceOf(NotFoundError);
    expect(counting.stored()).toBe(0);
  });

  it("stores exactly one challenge when the preview resolves", async () => {
    const counting = countingStore();
    const error = await card(directReadPreview, { store: counting.store });
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect(counting.stored()).toBe(1);
  });

  it("bounds the preview transaction by the contract statement timeout", async () => {
    const counting = countingStore();
    const error = await executeAction(deps(counting.store), {
      action: slowPreviewAction,
      input: { companyRef: companyA },
      request: requestMeta(),
      principal: {
        mode: "staff",
        session: { userId: annaId },
        companySelector: companyA,
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreInvariantError);
    expect(causeChain(error)).toContain("statement timeout");
    expect(counting.stored()).toBe(0);
  });

  it("hands the preview the target resolved inside its own transaction", async () => {
    const error = await executeAction(deps(createInMemoryConfirmationStore()), {
      action: customerPreviewAction,
      input: { companyRef: companyA },
      request: requestMeta(),
      principal: { mode: "customer", session: { userId: annaId } },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect(resolverPasses.length).toBeGreaterThan(1);
    expect(
      (error as ConfirmationRequiredError).challenge.preview?.lines[0]?.value,
    ).toBe(String(resolverPasses.length));
  });

  it("lands the audit row of an audit: true callee read from the preview", async () => {
    const error = await card(calledAuditedReadPreview, {});
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    const rows = await database.runtime.db
      .select({ companyId: auditLog.companyId, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, peerAuditedReadContract.name));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(companyA);
  });

  it("refuses an escaped preview call once the preview resolved", async () => {
    const error = await card(escapingPreview, {});
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    const escaped = escapedPreviewCall;
    expect(escaped).toBeDefined();
    const leaked = await (escaped as ActionPreviewEnv["call"])(getCompanyName, {
      companyRef: companyA,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(leaked).toBeInstanceOf(CoreInvariantError);
    expect((leaked as CoreInvariantError).message).toContain(
      "outside its handler execution",
    );
  });

  it("leaves confirmationSummary on input and company scope alone", async () => {
    const error = await card(summaryOnlyAction, {});
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    expect((error as ConfirmationRequiredError).challenge.summary).toBe(
      "companyId",
    );
    expect(
      (error as ConfirmationRequiredError).challenge.preview,
    ).toBeUndefined();
  });
});
