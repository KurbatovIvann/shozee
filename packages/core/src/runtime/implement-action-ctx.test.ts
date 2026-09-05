/**
 * SHO-416: `implementAction` threads the contract's `principal` literal
 * into the handler so a staff handler reads `ctx.companyId` without a
 * principal guard, and a customer-only field does not type-check.
 *
 * These assertions fail `tsc --noEmit` when the narrowing is lost.
 * Runtime is unchanged; the pipeline still constructs contexts via the
 * matching factory.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../contract/index.js";
import type { ActionCtxFor } from "./context/types.js";
import { implementAction } from "./implement-action.js";

const input = z.object({ orderId: z.uuid() });
const output = z.object({ ok: z.boolean() });

const auditTarget = (): { type: string; id: string } => ({
  type: "order",
  id: "order-1",
});

const resolveTarget = (): Promise<{
  companyId: string;
  resource: { paymentId: string };
}> =>
  Promise.resolve({
    companyId: "company-1",
    resource: { paymentId: "payment-1" },
  });

describe("ActionCtxFor (compile level)", () => {
  it("gives staff handlers companyId and not customer target", () => {
    expectTypeOf<ActionCtxFor<"staff">>().toHaveProperty("companyId");
    expectTypeOf<ActionCtxFor<"staff">>().toHaveProperty("membership");
    expectTypeOf<ActionCtxFor<"staff">>().not.toHaveProperty("target");
    expectTypeOf<ActionCtxFor<"staff">["principal"]>().toEqualTypeOf<"staff">();
    expectTypeOf<ActionCtxFor<"staff">["companyId"]>().toEqualTypeOf<string>();
  });

  it("gives customer handlers target and not staff companyId", () => {
    expectTypeOf<ActionCtxFor<"customer">>().toHaveProperty("target");
    expectTypeOf<ActionCtxFor<"customer">>().not.toHaveProperty("companyId");
    expectTypeOf<ActionCtxFor<"customer">>().not.toHaveProperty("membership");
    expectTypeOf<
      ActionCtxFor<"customer">["principal"]
    >().toEqualTypeOf<"customer">();
  });
});

describe("implementAction handler ctx (compile level)", () => {
  it("infers StaffCtx from a staff contract so companyId needs no guard", () => {
    const contract = defineActionContract({
      name: "orders.confirm",
      description: "Confirm a new order.",
      principal: "staff",
      transport: "client",
      input,
      output,
      permissions: ["orders:confirm"],
      aiExposure: "exposed",
      risk: "write",
      requiresConfirmation: false,
      idempotent: true,
      emits: ["orders.confirmed"],
      atomicCalls: [],
      atomicCallers: [],
      audit: true,
      timeout: 10_000,
    });

    const action = implementAction(contract, {
      handler: (_input, ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<ActionCtxFor<"staff">>();
        expectTypeOf(ctx.principal).toEqualTypeOf<"staff">();
        expectTypeOf(ctx.companyId).toEqualTypeOf<string>();
        expectTypeOf(ctx).not.toHaveProperty("target");
        return Promise.resolve({ ok: true });
      },
      auditTarget,
    });

    expect(action.contract).toBe(contract);
  });

  it("infers CustomerCtx from a customer contract so target is present", () => {
    const contract = defineActionContract({
      name: "payments.getOwn",
      description: "Get the customer's own payment.",
      principal: "customer",
      transport: "client",
      input,
      output,
      permissions: [],
      aiExposure: "internal",
      risk: "read",
      requiresConfirmation: false,
      idempotent: false,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      audit: false,
      timeout: 5_000,
    });

    const action = implementAction(contract, {
      handler: (_input, ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<ActionCtxFor<"customer">>();
        expectTypeOf(ctx.principal).toEqualTypeOf<"customer">();
        expectTypeOf(ctx).toHaveProperty("target");
        expectTypeOf(ctx).not.toHaveProperty("companyId");
        expectTypeOf(ctx).not.toHaveProperty("membership");
        return Promise.resolve({ ok: true });
      },
      resolveTarget,
    });

    expect(action.resolveTarget).toBe(resolveTarget);
  });
});
