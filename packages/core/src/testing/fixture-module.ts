/**
 * Test-only fixture module for fnd-T22 (core.md §12–§13, blueprint §2.1).
 *
 * Isolation reads stay in `fixture-actions.ts`. This file is the write /
 * event / atomic / social surface the inherited protocol suites and the
 * invariant run exercise end-to-end. Not exported from
 * `@showzy/core/testing`.
 */
import { randomUUID } from "node:crypto";

import { domainEvents, type Database, type ReadTx, type Tx } from "@showzy/db";
import {
  fixtureCompanyFollows,
  fixtureDiscoveryCompanies,
  fixtureDiscoveryProducts,
  fixtureProductComments,
} from "@showzy/db/testing/fixtures";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { defineActionContract } from "../contract/define-action-contract.js";
import { ConflictError, CoreInvariantError } from "../errors/index.js";
import { defineEvent } from "../runtime/events/define-event.js";
import { defineEventHandler } from "../runtime/events/define-event-handler.js";
import { eventEnvelopeSchema } from "../runtime/events/envelope.js";
import { implementAction } from "../runtime/implement-action.js";
import { kitIdentities } from "./identities.js";

const contractDefaults = {
  aiExposure: "internal" as const,
  requiresConfirmation: false,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
};

function requireWritable(capability: ReadTx | Tx): Tx {
  if (!("insert" in capability)) {
    throw new CoreInvariantError(
      "protocol fixture expected the writable capability",
    );
  }
  return capability;
}

export const noted = defineEvent({
  name: "kitFixture.noted",
  version: 1,
  scope: "tenant",
  payload: z.object({ noteId: z.uuid() }),
});

export const orderConfirmed = defineEvent({
  name: "kitOrders.confirmed",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

export const stockAdjusted = defineEvent({
  name: "kitCatalog.stockAdjusted",
  version: 1,
  scope: "tenant",
  payload: z.object({ productId: z.uuid(), delta: z.number().int() }),
});

export function createProtocolFixtureActions() {
  const createNote = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitFixture.createNote",
      description: "Idempotent staff write that emits a tenant event.",
      principal: "staff",
      transport: "client",
      input: z.object({
        noteId: z.uuid(),
        body: z.string().min(1),
        failAfterEmit: z.boolean(),
      }),
      output: z.object({ noteId: z.uuid() }),
      permissions: ["kitFixture:write"],
      risk: "write",
      idempotent: true,
      emits: ["kitFixture.noted"],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await requireWritable(ctx.db).insert(fixtureProductComments).values({
          id: input.noteId,
          productId: kitIdentities.products.published,
          authorUserId: ctx.userId,
          parentCommentId: null,
          body: input.body,
        });
        ctx.emit(noted, {
          aggregate: { type: "note", id: input.noteId },
          payload: { noteId: input.noteId },
        });
        if (input.failAfterEmit) {
          throw new ConflictError("Injected emit-then-fail.");
        }
        return { noteId: input.noteId };
      },
      auditTarget: (env) => {
        const noteId = readNoteId(env.input);
        return { type: "note", id: noteId };
      },
    },
  );

  const leakyCreateNote = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitFixture.leakyCreateNote",
      description: "Non-idempotent twin — replay re-runs the side effect.",
      principal: "staff",
      transport: "client",
      input: z.object({
        noteId: z.uuid(),
        body: z.string().min(1),
        failAfterEmit: z.boolean(),
      }),
      output: z.object({ noteId: z.uuid() }),
      permissions: ["kitFixture:write"],
      risk: "write",
      idempotent: false,
      emits: [],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await requireWritable(ctx.db)
          .update(fixtureDiscoveryProducts)
          .set({
            commentCount: sql`${fixtureDiscoveryProducts.commentCount} + 1`,
          })
          .where(
            eq(
              fixtureDiscoveryProducts.productId,
              kitIdentities.products.published,
            ),
          );
        return { noteId: input.noteId };
      },
      auditTarget: () => ({ type: "note", id: "leaky" }),
    },
  );

  const projectNote = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitChat.projectNote",
      description: "Chat-like consumer of kitFixture.noted.",
      principal: "system",
      systemScope: "tenant",
      transport: "internal",
      input: eventEnvelopeSchema(z.object({ noteId: z.uuid() })),
      output: z.object({ ok: z.boolean() }),
      permissions: [],
      risk: "write",
      idempotent: true,
      emits: [],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (_input, ctx) => {
        if (ctx.scope !== "tenant") {
          throw new CoreInvariantError("projectNote expects tenant system");
        }
        await requireWritable(ctx.db)
          .update(fixtureDiscoveryProducts)
          .set({
            commentCount: sql`${fixtureDiscoveryProducts.commentCount} + 1`,
          })
          .where(
            eq(
              fixtureDiscoveryProducts.productId,
              kitIdentities.products.published,
            ),
          );
        return { ok: true };
      },
      auditTarget: () => ({ type: "note-card", id: "kitChat" }),
    },
  );

  const noteProjector = defineEventHandler({
    event: noted,
    consumer: "kitChat.note-projector",
    action: projectNote,
  });

  const decrementStock = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitCatalog.decrementStock",
      description: "Atomic stock decrement for the kitOrders.confirm edge.",
      principal: "staff",
      transport: "internal",
      input: z.object({
        productId: z.uuid(),
        quantity: z.number().int().positive(),
      }),
      output: z.object({ unitsLeft: z.number().int() }),
      permissions: ["kitCatalog:manageStock"],
      risk: "write",
      idempotent: false,
      emits: ["kitCatalog.stockAdjusted"],
      atomicCallers: ["kitOrders.confirm", "kitOrders.leakyConfirm"],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
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
          aggregate: { type: "stock", id: input.productId },
          payload: { productId: input.productId, delta: -input.quantity },
        });
        return row;
      },
      auditTarget: () => ({ type: "stock", id: "kitCatalog" }),
    },
  );

  const confirmOrder = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitOrders.confirm",
      description: "Atomic root: persist a note-order and decrement stock.",
      principal: "staff",
      transport: "client",
      input: z.object({
        orderId: z.uuid(),
        productId: z.uuid(),
        quantity: z.number().int().positive(),
        failAfterCall: z.boolean(),
      }),
      output: z.object({ unitsLeft: z.number().int() }),
      permissions: ["kitOrders:confirm"],
      risk: "write",
      idempotent: true,
      emits: ["kitOrders.confirmed"],
      atomicCalls: ["kitCatalog.decrementStock"],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await requireWritable(ctx.db).insert(fixtureProductComments).values({
          id: input.orderId,
          productId: kitIdentities.products.published,
          authorUserId: ctx.userId,
          parentCommentId: null,
          body: "confirmed",
        });
        const stock = await ctx.callAtomic(decrementStock, {
          productId: input.productId,
          quantity: input.quantity,
        });
        ctx.emit(orderConfirmed, {
          aggregate: { type: "order", id: input.orderId },
          payload: { orderId: input.orderId },
        });
        if (input.failAfterCall) {
          throw new ConflictError("Root failed after the atomic call.");
        }
        return stock;
      },
      auditTarget: (env) => ({
        type: "order",
        id: readOrderId(env.input),
      }),
    },
  );

  const undeclaredTouch = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitCatalog.undeclaredTouch",
      description: "Write callee that is not on any atomic edge.",
      principal: "staff",
      transport: "internal",
      input: z.object({ productId: z.uuid() }),
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
      input: z.object({ productId: z.uuid() }),
      output: z.object({ ok: z.boolean() }),
      permissions: ["kitOrders:confirm"],
      risk: "write",
      idempotent: true,
      emits: [],
      atomicCalls: ["kitCatalog.decrementStock"],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await ctx.callAtomic(undeclaredTouch, { productId: input.productId });
        return { ok: true };
      },
      auditTarget: () => ({ type: "order", id: "undeclared" }),
    },
  );

  const nestedCallee = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitCatalog.nestedStock",
      description: "Declared callee that illegally nests another atomic call.",
      principal: "staff",
      transport: "internal",
      input: z.object({ productId: z.uuid() }),
      output: z.object({ ok: z.boolean() }),
      permissions: ["kitCatalog:manageStock"],
      risk: "write",
      idempotent: false,
      emits: [],
      atomicCallers: ["kitOrders.confirmNested"],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await ctx.callAtomic(undeclaredTouch, { productId: input.productId });
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
      input: z.object({ productId: z.uuid() }),
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
      handler: async (input, ctx) => {
        await ctx.callAtomic(nestedCallee, { productId: input.productId });
        return { ok: true };
      },
      auditTarget: () => ({ type: "order", id: "nested" }),
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

  const createLeakyConfirmOrder = (db: Database) =>
    implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "kitOrders.leakyConfirm",
        description:
          "Atomic root that smuggles an outbox row out of the handler transaction.",
        principal: "staff",
        transport: "client",
        input: z.object({
          orderId: z.uuid(),
          productId: z.uuid(),
          quantity: z.number().int().positive(),
          failAfterCall: z.boolean(),
        }),
        output: z.object({ unitsLeft: z.number().int() }),
        permissions: ["kitOrders:confirm"],
        risk: "write",
        idempotent: true,
        emits: ["kitOrders.confirmed"],
        atomicCalls: ["kitCatalog.decrementStock"],
        audit: true,
        timeout: 5_000,
      }),
      {
        handler: async (input, ctx) => {
          await requireWritable(ctx.db).insert(fixtureProductComments).values({
            id: input.orderId,
            productId: kitIdentities.products.published,
            authorUserId: ctx.userId,
            parentCommentId: null,
            body: "confirmed",
          });
          const stock = await ctx.callAtomic(decrementStock, {
            productId: input.productId,
            quantity: input.quantity,
          });
          ctx.emit(orderConfirmed, {
            aggregate: { type: "order", id: input.orderId },
            payload: { orderId: input.orderId },
          });
          if (input.failAfterCall) {
            await db.insert(domainEvents).values({
              id: randomUUID(),
              name: "kitOrders.confirmed",
              version: 1,
              occurredAt: new Date(),
              companyId: kitIdentities.companies.a,
              aggregateType: "order",
              aggregateId: input.orderId,
              aggregateSequence: 1n,
              actorType: "user",
              actorId: ctx.userId,
              channel: "ui",
              requestId: "leaky-confirm",
              correlationId: "leaky-confirm",
              causationId: "leaky-confirm",
              payload: { orderId: input.orderId },
            });
            throw new ConflictError("Root failed after the atomic call.");
          }
          return stock;
        },
        auditTarget: (env) => ({
          type: "order",
          id: readOrderId(env.input),
        }),
      },
    );

  const setFollow = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitFixture.setFollow",
      description: "Own-user desired-state follow write (account principal).",
      principal: "account",
      transport: "client",
      input: z.object({
        companyId: z.uuid(),
        following: z.boolean(),
      }),
      output: z.object({ following: z.boolean() }),
      permissions: [],
      risk: "write",
      idempotent: true,
      emits: [],
      audit: true,
      rateLimit: { limit: 3, windowSec: 60, scope: "user" },
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        const tx = requireWritable(ctx.db);
        const existing = await tx
          .select({ companyId: fixtureCompanyFollows.companyId })
          .from(fixtureCompanyFollows)
          .where(
            and(
              eq(fixtureCompanyFollows.userId, ctx.userId),
              eq(fixtureCompanyFollows.companyId, input.companyId),
            ),
          )
          .limit(1);
        const hasFollow = existing[0] !== undefined;
        if (input.following === hasFollow) {
          return { following: hasFollow };
        }
        if (input.following) {
          await tx.insert(fixtureCompanyFollows).values({
            userId: ctx.userId,
            companyId: input.companyId,
          });
          await tx
            .update(fixtureDiscoveryCompanies)
            .set({
              followerCount: sql`${fixtureDiscoveryCompanies.followerCount} + 1`,
            })
            .where(eq(fixtureDiscoveryCompanies.companyId, input.companyId));
        } else {
          await tx
            .delete(fixtureCompanyFollows)
            .where(
              and(
                eq(fixtureCompanyFollows.userId, ctx.userId),
                eq(fixtureCompanyFollows.companyId, input.companyId),
              ),
            );
          await tx
            .update(fixtureDiscoveryCompanies)
            .set({
              followerCount: sql`${fixtureDiscoveryCompanies.followerCount} - 1`,
            })
            .where(eq(fixtureDiscoveryCompanies.companyId, input.companyId));
        }
        return { following: input.following };
      },
      auditTarget: () => ({ type: "follow", id: "kitFixture" }),
    },
  );

  const leakySetFollow = implementAction(
    defineActionContract({
      ...contractDefaults,
      name: "kitFixture.leakySetFollow",
      description: "Retry-unsafe follow twin — always bumps the counter.",
      principal: "account",
      transport: "client",
      input: z.object({
        companyId: z.uuid(),
        following: z.boolean(),
      }),
      output: z.object({ following: z.boolean() }),
      permissions: [],
      risk: "write",
      idempotent: true,
      emits: [],
      audit: true,
      timeout: 5_000,
    }),
    {
      handler: async (input, ctx) => {
        await requireWritable(ctx.db)
          .update(fixtureDiscoveryCompanies)
          .set({
            followerCount: sql`${fixtureDiscoveryCompanies.followerCount} + 1`,
          })
          .where(eq(fixtureDiscoveryCompanies.companyId, input.companyId));
        return { following: input.following };
      },
      auditTarget: () => ({ type: "follow", id: "leaky" }),
    },
  );

  return {
    createNote,
    leakyCreateNote,
    projectNote,
    noteProjector,
    decrementStock,
    confirmOrder,
    undeclaredTouch,
    confirmUndeclared,
    nestedCallee,
    confirmNested,
    mismatchStock,
    confirmMismatch,
    createLeakyConfirmOrder,
    setFollow,
    leakySetFollow,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNoteId(input: unknown): string {
  if (!isRecord(input) || typeof input["noteId"] !== "string") {
    return "unknown";
  }
  return input["noteId"];
}

function readOrderId(input: unknown): string {
  if (!isRecord(input) || typeof input["orderId"] !== "string") {
    return "unknown";
  }
  return input["orderId"];
}
