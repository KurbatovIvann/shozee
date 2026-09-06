import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import { implementAction } from "@showzy/core";
import { ConflictError } from "@showzy/core/errors";
import {
  atomicCallSuite,
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  companyCustomerInviteRedemptions,
  companyCustomerInvites,
} from "@showzy/db/schema/invites";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { z } from "zod";

import { invitesAccepted } from "../events/accepted.js";
import {
  acceptCustomerInvite,
  assertCustomerAcceptCtx,
  resolveAcceptInviteTarget,
} from "../services/accept-invite.js";
import { hashInviteToken } from "../services/token-hash.js";

const HOUR_MS = 60 * 60 * 1000;
const futureExpiry = new Date(Date.now() + 7 * 24 * HOUR_MS);

function invitePlaintext(id: string): string {
  return `invite-row-${id}`;
}

const fixtures = {
  fail: randomUUID(),
  success: randomUUID(),
};

let kit: TestKit;

const contractDefaults = {
  aiExposure: "internal" as const,
  requiresConfirmation: false,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  errors: [],
};

const acceptThenFail = implementAction(
  defineActionContract({
    name: "invites.accept",
    description:
      "Test-local invites.accept twin that can fail after the atomic CRM write.",
    principal: "customer",
    transport: "client",
    input: z.strictObject({
      token: z.string().min(1),
      failAfterCall: z.boolean(),
    }),
    output: z.strictObject({
      inviteId: z.uuid(),
      customerId: z.uuid(),
      created: z.boolean(),
    }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["invites.accepted"],
    atomicCalls: ["customers.applyInviteCrm"],
    atomicCallers: [],
    errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
    audit: true,
    timeout: 10_000,
  }),
  {
    resolveTarget: (input, env) => resolveAcceptInviteTarget(input, env),
    handler: async (input, ctx) => {
      assertCustomerAcceptCtx(ctx);
      const result = await acceptCustomerInvite({ ctx });
      if (!result.replayed) {
        ctx.emit(invitesAccepted, {
          aggregate: { type: "invite", id: result.inviteId },
          payload: {
            inviteId: result.inviteId,
            customerId: result.customerId,
            created: result.created,
          },
        });
      }
      if (input.failAfterCall) {
        throw new ConflictError("Root failed after the atomic call.");
      }
      return {
        inviteId: result.inviteId,
        customerId: result.customerId,
        created: result.created,
      };
    },
    auditTarget: () => ({ type: "invite", id: "accept-atomic-twin" }),
  },
);

const undeclaredTouch = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.undeclaredTouch",
    description: "Write callee that is not on any atomic edge.",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => Promise.resolve({ ok: true }),
    auditTarget: () => ({ type: "stock", id: "undeclared" }),
  },
);

const confirmUndeclared = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmUndeclared",
    description: "Root whose handler calls an undeclared atomic callee.",
    principal: "staff",
    transport: "client",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitOrders:confirm"],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["customers.applyInviteCrm"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(undeclaredTouch, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "undeclared" }),
  },
);

const mismatchStock = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.mismatchStock",
    description: "Staff callee declared for a system atomic root (bug).",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    atomicCallers: ["kitOrders.confirmMismatch"],
    errors: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => Promise.resolve({ ok: true }),
    auditTarget: () => ({ type: "stock", id: "mismatch" }),
  },
);

const confirmMismatch = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmMismatch",
    description: "System root reaching a staff atomic callee (a bug).",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: [],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["kitCatalog.mismatchStock"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(mismatchStock, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "mismatch" }),
  },
);

const nestedCallee = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitCatalog.nestedStock",
    description: "Declared callee that illegally nests another atomic call.",
    principal: "staff",
    transport: "internal",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitCatalog:manageStock"],
    risk: "write",
    idempotent: false,
    emits: [],
    atomicCallers: ["kitOrders.confirmNested"],
    errors: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(undeclaredTouch, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "stock", id: "nested" }),
  },
);

const confirmNested = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "kitOrders.confirmNested",
    description: "Root of a declared edge whose callee nests atomically.",
    principal: "staff",
    transport: "client",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    permissions: ["kitOrders:confirm"],
    risk: "write",
    idempotent: true,
    emits: [],
    atomicCalls: ["kitCatalog.nestedStock"],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: async (_input, ctx) => {
      await ctx.callAtomic(nestedCallee, {});
      return { ok: true };
    },
    auditTarget: () => ({ type: "order", id: "nested" }),
  },
);

async function countRedemptions(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomerInviteRedemptions)
    .where(
      eq(companyCustomerInviteRedemptions.companyId, kitIdentities.companies.a),
    );
  return rows[0]?.value ?? 0;
}

async function countCustomers(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomers)
    .where(eq(companyCustomers.companyId, kitIdentities.companies.a));
  return rows[0]?.value ?? 0;
}

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(companyCustomerInvites).values([
    {
      id: fixtures.fail,
      companyId: kitIdentities.companies.a,
      invitedBy: kitIdentities.users.anna,
      tokenHash: hashInviteToken(invitePlaintext(fixtures.fail)),
      isReusable: false,
      maxUses: 1,
      usesCount: 0,
      expiresAt: futureExpiry,
      status: "pending",
      name: "Atomic fail",
    },
    {
      id: fixtures.success,
      companyId: kitIdentities.companies.a,
      invitedBy: kitIdentities.users.anna,
      tokenHash: hashInviteToken(invitePlaintext(fixtures.success)),
      isReusable: false,
      maxUses: 1,
      usesCount: 0,
      expiresAt: futureExpiry,
      status: "pending",
      name: "Atomic success",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

atomicCallSuite(
  () => kit,
  [
    {
      root: acceptThenFail,
      successInput: {
        token: invitePlaintext(fixtures.success),
        failAfterCall: false,
      },
      failureInput: {
        token: invitePlaintext(fixtures.fail),
        failAfterCall: true,
      },
      readRootEffect: countRedemptions,
      readCalleeEffect: countCustomers,
      undeclared: { action: confirmUndeclared, input: {} },
      mismatch: { action: confirmMismatch, input: {} },
      nested: { action: confirmNested, input: {} },
    },
  ],
);
