/**
 * Per-mode fixture actions for the kit self-tests. Correct implementations
 * honour the principal's isolation rule; leaky twins are seeded violations
 * the suites must fail on (fnd-T21 tests-first: pass on correct, fail on
 * leak). Not exported from `@showzy/core/testing` — modules bring their
 * own actions.
 */
import { randomUUID } from "node:crypto";

import {
  auditLog,
  companyMembers,
  domainEvents,
  type Database,
} from "@showzy/db";
import {
  fixtureCompanies,
  fixtureCompanyFollows,
  fixtureCrmCustomers,
  fixtureDiscoveryProducts,
  fixtureProducts,
} from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { defineActionContract } from "../contract/define-action-contract.js";
import { CoreInvariantError, NotFoundError } from "../errors/index.js";
import { defineEvent } from "../runtime/events/define-event.js";
import { implementAction } from "../runtime/implement-action.js";
import type { ResolvedTarget, TargetResolutionEnv } from "../runtime/types.js";
import { kitIdentities } from "./identities.js";
import {
  resolveKitShareTarget,
  resolveLeakyKitShareTarget,
} from "./share-fixture.js";

const contractDefaults = {
  transport: "client" as const,
  aiExposure: "internal" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
};

type CrmRow = typeof fixtureCrmCustomers.$inferSelect;
type ProductRow = typeof fixtureProducts.$inferSelect;

function isNamedResource(value: unknown): value is Pick<ProductRow, "name"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

const productInput = z.object({ productId: z.uuid() });
const productOutput = z.object({ id: z.uuid(), name: z.string() });
const crmInput = z.object({ customerId: z.uuid() });
const crmOutput = z.object({ id: z.uuid(), companyId: z.uuid() });
const browseOutput = z.object({
  items: z.array(
    z.object({
      productId: z.uuid(),
      name: z.string(),
      likeCount: z.number().int(),
    }),
  ),
});
const mineOutput = z.object({
  companyIds: z.array(z.uuid()),
  followCompanyIds: z.array(z.uuid()),
});
const shareInput = z.object({ token: z.string().min(1), documentId: z.uuid() });
const shareOutput = z.object({
  documentId: z.uuid(),
  companyId: z.uuid(),
});

const shareSubmitted = defineEvent({
  name: "kitFixture.shareSubmitted",
  version: 1,
  scope: "tenant",
  payload: z.object({ documentId: z.uuid() }),
});

async function resolveOwnCrm(
  input: { customerId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<CrmRow>> {
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
}

/** Seeded violation: any CRM row is "owned" by the caller. */
async function resolveAnyCrm(
  input: { customerId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<CrmRow>> {
  const rows = await env.tx
    .select()
    .from(fixtureCrmCustomers)
    .where(eq(fixtureCrmCustomers.id, input.customerId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return { companyId: row.companyId, resource: row };
}

async function resolvePublishedProduct(
  input: { productId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<ProductRow>> {
  const productRows = await env.tx
    .select()
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, input.productId))
    .limit(1);
  const product = productRows[0];
  if (product === undefined || !product.published) {
    throw new NotFoundError();
  }
  const companyRows = await env.tx
    .select()
    .from(fixtureCompanies)
    .where(eq(fixtureCompanies.id, product.companyId))
    .limit(1);
  const company = companyRows[0];
  if (company === undefined || !company.published) {
    throw new NotFoundError();
  }
  return { companyId: product.companyId, resource: product };
}

/** Seeded violation: unpublished and foreign-company products resolve. */
async function resolveAnyProduct(
  input: { productId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<ProductRow>> {
  const rows = await env.tx
    .select()
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, input.productId))
    .limit(1);
  const product = rows[0];
  if (product === undefined) {
    throw new NotFoundError();
  }
  return { companyId: product.companyId, resource: product };
}

export function createCorrectFixtureActions() {
  return {
    staffGetProduct: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.getProduct",
        description: "Staff read of one product in the verified company.",
        principal: "staff",
        input: productInput,
        output: productOutput,
        permissions: ["kitFixture:view"],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          const rows = await ctx.db
            .select({ id: fixtureProducts.id, name: fixtureProducts.name })
            .from(fixtureProducts)
            .where(
              and(
                eq(fixtureProducts.id, input.productId),
                eq(fixtureProducts.companyId, ctx.companyId),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new NotFoundError();
          }
          return row;
        },
      },
    ),
    customerGetOwnCrm: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.getOwnCrm",
        description: "Customer read of an owned CRM record.",
        principal: "customer",
        input: crmInput,
        output: crmOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveOwnCrm,
        handler: (input, ctx) => {
          return Promise.resolve({
            id: input.customerId,
            companyId: ctx.target.companyId,
          });
        },
      },
    ),
    publicGetPublishedProduct: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.getPublishedProduct",
        description: "Anonymous read of one published product.",
        principal: "public",
        publicScope: "target",
        input: productInput,
        output: productOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolvePublishedProduct,
        handler: (input, ctx) => {
          if (ctx.scope !== "target") {
            throw new CoreInvariantError("fixture expects public-target");
          }
          const resource = ctx.target.resource;
          if (!isNamedResource(resource)) {
            throw new CoreInvariantError(
              "public-target fixture resolver must return { id, name }",
            );
          }
          return Promise.resolve({
            id: input.productId,
            name: resource.name,
          });
        },
      },
    ),
    publicBrowseDiscovery: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.browsePublishedProducts",
        description: "Anonymous global discovery over the fixture grant.",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "fixture.discovery",
        input: z.object({}),
        output: browseOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          if (ctx.scope !== "globalProjection") {
            throw new CoreInvariantError("fixture expects public-global");
          }
          const rows = await ctx.db.from("discoveryProducts");
          return {
            items: rows.map((row) => ({
              productId: String(row.productId),
              name: String(row.name),
              likeCount: Number(row.likeCount),
            })),
          };
        },
      },
    ),
    systemGetProduct: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.systemGetProduct",
        description: "Tenant-scoped system read of one company product.",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        input: productInput,
        output: productOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          if (ctx.scope !== "tenant") {
            throw new CoreInvariantError("fixture expects tenant system");
          }
          const rows = await ctx.db
            .select({ id: fixtureProducts.id, name: fixtureProducts.name })
            .from(fixtureProducts)
            .where(
              and(
                eq(fixtureProducts.id, input.productId),
                eq(fixtureProducts.companyId, ctx.companyId),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (row === undefined) {
            throw new NotFoundError();
          }
          return row;
        },
      },
    ),
    systemGlobalSweep: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.systemGlobalSweep",
        description:
          "Global system no-op used to prove crossTenantSuite accepts system-global jobs.",
        principal: "system",
        transport: "internal",
        systemScope: "global",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        permissions: [],
        risk: "write",
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: (_input, ctx) => {
          if (ctx.scope !== "global") {
            throw new CoreInvariantError("fixture expects global system");
          }
          return Promise.resolve({ ok: true });
        },
        auditTarget: () => ({ type: "sweep", id: "fixture" }),
      },
    ),
    consumerBrowseDiscovery: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.consumerBrowse",
        description: "Authenticated discovery of published products.",
        principal: "consumer",
        input: z.object({}),
        output: browseOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          const rows = await ctx.db
            .select({
              productId: fixtureDiscoveryProducts.productId,
              name: fixtureDiscoveryProducts.name,
              likeCount: fixtureDiscoveryProducts.likeCount,
            })
            .from(fixtureDiscoveryProducts);
          return {
            items: rows.map((row) => ({
              productId: row.productId,
              name: row.name,
              likeCount: row.likeCount,
            })),
          };
        },
      },
    ),
    accountListMine: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.listMine",
        description: "Own-user companies and follows, no tenant selector.",
        principal: "account",
        input: z.object({}),
        output: mineOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        handler: async (_input, ctx) => {
          const owned = await ctx.db
            .select({ companyId: companyMembers.companyId })
            .from(companyMembers)
            .where(eq(companyMembers.userId, ctx.userId));
          const follows = await ctx.db
            .select({ companyId: fixtureCompanyFollows.companyId })
            .from(fixtureCompanyFollows)
            .where(eq(fixtureCompanyFollows.userId, ctx.userId));
          return {
            companyIds: owned.map((row) => row.companyId).sort(),
            followCompanyIds: follows.map((row) => row.companyId).sort(),
          };
        },
      },
    ),
    shareGetDocument: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.getShared",
        description: "Read a document through a valid share token.",
        principal: "share",
        input: shareInput,
        output: shareOutput,
        permissions: [],
        risk: "read",
        audit: false,
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveKitShareTarget,
        handler: (input, ctx) => {
          return Promise.resolve({
            documentId: input.documentId,
            companyId: ctx.target.companyId,
          });
        },
      },
    ),
    shareSubmitSignature: implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitFixture.submitShare",
        description: "Persist a dual-signed container through a share token.",
        principal: "share",
        input: shareInput,
        output: shareOutput,
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        emits: ["kitFixture.shareSubmitted"],
        timeout: 5_000,
      }),
      {
        resolveTarget: resolveKitShareTarget,
        auditTarget: (env) => {
          const parsed = shareInput.parse(env.input);
          return { type: "document", id: parsed.documentId };
        },
        auditSnapshot: () => ({
          cn: "Test Signer",
          org: "Acme",
          taxId: "1234567890",
          role: "buyer",
        }),
        handler: (input, ctx) => {
          ctx.emit(shareSubmitted, {
            aggregate: { type: "document", id: input.documentId },
            payload: { documentId: input.documentId },
          });
          return Promise.resolve({
            documentId: input.documentId,
            companyId: ctx.target.companyId,
          });
        },
      },
    ),
  };
}

/**
 * Seeded-violation twins. Public-global and consumer leaks close over the
 * writable process db because a correct public-global capability cannot
 * reach domain tables — that closure *is* the bug the suite must catch.
 */
export function createLeakyFixtureActions(db: Database) {
  const correct = createCorrectFixtureActions();
  return {
    staffGetProduct: implementAction(correct.staffGetProduct.contract, {
      handler: async (input, ctx) => {
        const rows = await ctx.db
          .select({ id: fixtureProducts.id, name: fixtureProducts.name })
          .from(fixtureProducts)
          .where(eq(fixtureProducts.id, input.productId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          throw new NotFoundError();
        }
        return row;
      },
    }),
    customerGetOwnCrm: implementAction(correct.customerGetOwnCrm.contract, {
      resolveTarget: resolveAnyCrm,
      handler: correct.customerGetOwnCrm.handler,
    }),
    publicGetPublishedProduct: implementAction(
      correct.publicGetPublishedProduct.contract,
      {
        resolveTarget: resolveAnyProduct,
        handler: correct.publicGetPublishedProduct.handler,
      },
    ),
    publicBrowseDiscovery: implementAction(
      correct.publicBrowseDiscovery.contract,
      {
        handler: async () => {
          const rows = await db.select().from(fixtureProducts);
          return {
            items: rows.map((row) => ({
              productId: row.id,
              name: row.internalNote ?? row.name,
              likeCount: 0,
            })),
          };
        },
      },
    ),
    systemGetProduct: implementAction(correct.systemGetProduct.contract, {
      handler: async (input, ctx) => {
        if (ctx.scope !== "tenant") {
          throw new CoreInvariantError("fixture expects tenant system");
        }
        const rows = await ctx.db
          .select({ id: fixtureProducts.id, name: fixtureProducts.name })
          .from(fixtureProducts)
          .where(eq(fixtureProducts.id, input.productId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          throw new NotFoundError();
        }
        return row;
      },
    }),
    consumerBrowseDiscovery: implementAction(
      correct.consumerBrowseDiscovery.contract,
      {
        handler: async () => {
          const rows = await db.select().from(fixtureProducts);
          return {
            items: rows.map((row) => ({
              productId: row.id,
              name: row.internalNote ?? row.name,
              likeCount: 0,
            })),
          };
        },
      },
    ),
    accountListMine: implementAction(correct.accountListMine.contract, {
      handler: async (_input, ctx) => {
        const owned = await ctx.db
          .select({ companyId: companyMembers.companyId })
          .from(companyMembers);
        const follows = await ctx.db
          .select({ companyId: fixtureCompanyFollows.companyId })
          .from(fixtureCompanyFollows);
        return {
          companyIds: owned.map((row) => row.companyId).sort(),
          followCompanyIds: follows.map((row) => row.companyId).sort(),
        };
      },
    }),
    accountWritesCompanyScope: implementAction(
      correct.accountListMine.contract,
      {
        handler: async (_input, ctx) => {
          const owned = await ctx.db
            .select({ companyId: companyMembers.companyId })
            .from(companyMembers)
            .where(eq(companyMembers.userId, ctx.userId));
          const follows = await ctx.db
            .select({ companyId: fixtureCompanyFollows.companyId })
            .from(fixtureCompanyFollows)
            .where(eq(fixtureCompanyFollows.userId, ctx.userId));
          await db.insert(auditLog).values({
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            action: "kitFixture.listMine",
            actorType: "user",
            actorId: ctx.userId,
            channel: "ui",
            companyId: kitIdentities.companies.a,
            targetType: "account",
            targetId: ctx.userId,
            inputHash: "leaky-account-scope",
            outcome: "ok",
            durationMs: 0,
          });
          await db.insert(domainEvents).values({
            id: randomUUID(),
            name: "kitFixture.listed",
            version: 1,
            occurredAt: new Date(),
            companyId: kitIdentities.companies.a,
            aggregateType: "account",
            aggregateId: randomUUID(),
            aggregateSequence: 1n,
            actorType: "user",
            actorId: ctx.userId,
            channel: "ui",
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            causationId: ctx.requestId,
            payload: {},
          });
          return {
            companyIds: owned.map((row) => row.companyId).sort(),
            followCompanyIds: follows.map((row) => row.companyId).sort(),
          };
        },
      },
    ),
    shareGetDocument: implementAction(correct.shareGetDocument.contract, {
      resolveTarget: resolveLeakyKitShareTarget,
      handler: correct.shareGetDocument.handler,
    }),
    shareWritesCrm: implementAction(correct.shareSubmitSignature.contract, {
      resolveTarget: resolveKitShareTarget,
      auditTarget: (env) => {
        const parsed = shareInput.parse(env.input);
        return { type: "document", id: parsed.documentId };
      },
      auditSnapshot: () => ({
        cn: "Test Signer",
        org: "Acme",
        taxId: "1234567890",
        role: "buyer",
      }),
      handler: async (input, ctx) => {
        await db.insert(fixtureCrmCustomers).values({
          id: "00000000-0000-4000-8000-00000000f098",
          companyId: kitIdentities.companies.a,
          userId: kitIdentities.users.anna,
          displayName: "leaked share CRM",
        });
        return {
          documentId: input.documentId,
          companyId: ctx.target.companyId,
        };
      },
    }),
  };
}

/** Extra consumer leak: browsing writes a CRM row (ADR-0020 forbidden). */
export function createCrmWritingConsumerBrowse(db: Database) {
  const correct = createCorrectFixtureActions();
  return implementAction(correct.consumerBrowseDiscovery.contract, {
    handler: async (_input, ctx) => {
      await db.insert(fixtureCrmCustomers).values({
        id: "00000000-0000-4000-8000-00000000f099",
        companyId: kitIdentities.companies.a,
        userId: ctx.userId,
        displayName: "leaked CRM",
      });
      return { items: [] };
    },
  });
}
