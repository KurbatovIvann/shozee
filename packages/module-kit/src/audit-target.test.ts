import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_AUDIT_TYPE,
  VARIANT_AUDIT_TYPE,
  createAuditTarget,
  holderAuditTarget,
  pickNullableStringOr,
  pickString,
} from "./audit-target.js";

const variantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const productId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("audit-target factory", () => {
  it("pins catalog variant type to variant, never product_variant", () => {
    expect(VARIANT_AUDIT_TYPE).toBe("variant");
    expect(VARIANT_AUDIT_TYPE).not.toBe("product_variant");
    expect(PRODUCT_AUDIT_TYPE).toBe("product");

    const archiveVariant = holderAuditTarget({
      type: VARIANT_AUDIT_TYPE,
      field: "variantId",
      fallback: "unknown",
      sources: ["input"],
    });
    const createVariant = holderAuditTarget({
      type: VARIANT_AUDIT_TYPE,
      field: "variantId",
      fallback: "uncreated",
      sources: ["output", "input"],
    });

    expect(archiveVariant({ input: { variantId } }).type).toBe("variant");
    expect(archiveVariant({ input: { variantId } }).type).not.toBe(
      "product_variant",
    );
    expect(createVariant({ output: { variantId }, input: {} }).type).toBe(
      "variant",
    );
    expect(createVariant({ output: { variantId }, input: {} }).id).toBe(
      variantId,
    );
  });

  it("reads output then input and uses the fallback", () => {
    const target = holderAuditTarget({
      type: PRODUCT_AUDIT_TYPE,
      field: "productId",
      fallback: "uncreated",
      sources: ["output", "input"],
    });
    expect(target({ output: { productId }, input: {} })).toEqual({
      type: "product",
      id: productId,
    });
    expect(target({ input: { productId } })).toEqual({
      type: "product",
      id: productId,
    });
    expect(target({ input: {} })).toEqual({
      type: "product",
      id: "uncreated",
    });
  });

  it("preserves orders.create ids: output orderId then input customerId", () => {
    const orderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const customerId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const target = createAuditTarget({
      type: "order",
      fallback: "uncreated",
      steps: [
        {
          source: "output",
          schema: z.object({ orderId: z.string() }),
          pick: (data) => pickString("orderId", data),
        },
        {
          source: "input",
          schema: z.object({ customerId: z.string() }),
          pick: (data) => pickString("customerId", data),
        },
      ],
    });
    expect(target({ output: { orderId }, input: { customerId } })).toEqual({
      type: "order",
      id: orderId,
    });
    expect(target({ input: { customerId } })).toEqual({
      type: "order",
      id: customerId,
    });
  });

  it("preserves pricing price_list fallbacks uncreated/none", () => {
    const priceListId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const target = createAuditTarget({
      type: "price_list",
      fallback: "uncreated",
      steps: [
        {
          source: "output",
          schema: z.object({ id: z.string() }),
          pick: (data) => pickString("id", data),
        },
        {
          source: "output",
          schema: z.object({ priceListId: z.string().nullable() }),
          pick: (data) => pickString("priceListId", data),
        },
        {
          source: "input",
          schema: z.object({ id: z.string() }),
          pick: (data) => pickString("id", data),
        },
        {
          source: "input",
          schema: z.object({ priceListId: z.string().nullable() }),
          pick: (data) => pickNullableStringOr("priceListId", "none", data),
        },
      ],
    });
    expect(target({ output: { id: priceListId }, input: {} }).id).toBe(
      priceListId,
    );
    expect(target({ input: { priceListId: null } })).toEqual({
      type: "price_list",
      id: "none",
    });
    expect(target({ input: {} })).toEqual({
      type: "price_list",
      id: "uncreated",
    });
  });

  it("preserves chat upsert ids: output orderCardId then input payload.orderId", () => {
    const orderCardId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const envelope = z.object({
      payload: z.object({ orderId: z.string() }),
    });
    const target = createAuditTarget({
      type: "order-card",
      fallback: "unknown",
      steps: [
        {
          source: "output",
          schema: z.object({ orderCardId: z.string() }),
          pick: (data) => pickString("orderCardId", data),
        },
        {
          source: "input",
          schema: envelope,
          pick: (data) => {
            const parsed = envelope.safeParse(data);
            return parsed.success ? parsed.data.payload.orderId : undefined;
          },
        },
      ],
    });
    expect(target({ output: { orderCardId }, input: {} }).id).toBe(orderCardId);
    expect(target({ input: { payload: { orderId } } }).id).toBe(orderId);
    expect(target({ input: {} }).id).toBe("unknown");
  });
});

describe("the handler-resolved source (SHO-867)", () => {
  const orderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const resolvedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const target = holderAuditTarget({
    type: "order",
    field: "orderId",
    fallback: "unknown",
    sources: ["output", "resolved", "input"],
  });

  it("names the resolved record when a by-number write fails before output", () => {
    expect(target({ input: { orderNumber: "KA-131" }, resolvedId })).toEqual({
      type: "order",
      id: resolvedId,
    });
  });

  it("keeps the fallback when nothing resolved", () => {
    expect(target({ input: { orderNumber: "KA-999" } })).toEqual({
      type: "order",
      id: "unknown",
    });
  });

  it("leaves output and input precedence untouched", () => {
    expect(target({ output: { orderId }, input: {}, resolvedId }).id).toBe(
      orderId,
    );
    expect(target({ input: { orderId } }).id).toBe(orderId);
  });
});
