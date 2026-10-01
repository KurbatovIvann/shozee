import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
  VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
  createOrderContract,
} from "./create.contract.js";

const validId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

describe("orders.create contract", () => {
  it("is a staff client write with orders:create, idempotent audit, and orders.created", () => {
    expect(createOrderContract.name).toBe("orders.create");
    expect(createOrderContract.principal).toBe("staff");
    expect(createOrderContract.transport).toBe("client");
    expect(createOrderContract.risk).toBe("write");
    expect(createOrderContract.permissions).toEqual(["orders:create"]);
    expect(createOrderContract.aiExposure).toBe("exposed");
    expect(createOrderContract.audit).toBe(true);
    expect(createOrderContract.idempotent).toBe(true);
    expect(createOrderContract.emits).toEqual(["orders.created"]);
    expect(createOrderContract.atomicCalls).toEqual([]);
    expect(createOrderContract.timeout).toBe(20_000);
    expect(CREATE_ORDER_MAX_ITEMS).toBe(100);
    expect(CREATE_ORDER_COMMENT_MAX).toBe(2000);
  });

  it("accepts EntityRef customer/items with milli or decimal quantity", () => {
    expect(
      createOrderContract.input.parse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            quantity: { milli: "1000" },
          },
        ],
      }),
    ).toEqual({
      customer: { by: "id", id: validId },
      items: [
        {
          product: { by: "id", id: productId },
          quantity: { milli: "1000" },
        },
      ],
    });
    expect(
      createOrderContract.input.parse({
        customer: { by: "query", value: "  Katya  " },
        items: [
          {
            product: { by: "query", value: "Cake" },
            quantity: { decimal: "1.5" },
          },
        ],
      }),
    ).toEqual({
      customer: { by: "query", value: "Katya" },
      items: [
        {
          product: { by: "query", value: "Cake" },
          quantity: { decimal: "1.5" },
        },
      ],
    });
  });

  it("accepts additive variantSelection and keeps legacy variant exclusive", () => {
    expect(
      createOrderContract.input.parse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            variantSelection: { kind: "unspecified" },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: productId },
            variantSelection: { kind: "base" },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: productId },
            variantSelection: {
              kind: "reference",
              ref: { by: "query", value: "  Lemon  " },
            },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: productId },
            variant: { by: "id", id: validId },
            quantity: { milli: "1000" },
          },
        ],
      }),
    ).toEqual({
      customer: { by: "id", id: validId },
      items: [
        {
          product: { by: "id", id: productId },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
        {
          product: { by: "id", id: productId },
          variantSelection: { kind: "base" },
          quantity: { milli: "1000" },
        },
        {
          product: { by: "id", id: productId },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Lemon" },
          },
          quantity: { milli: "1000" },
        },
        {
          product: { by: "id", id: productId },
          variant: { by: "id", id: validId },
          quantity: { milli: "1000" },
        },
      ],
    });
    const both = createOrderContract.input.safeParse({
      customer: { by: "id", id: validId },
      items: [
        {
          product: { by: "id", id: productId },
          variant: { by: "id", id: validId },
          variantSelection: { kind: "base" },
          quantity: { milli: "1000" },
        },
      ],
    });
    expect(both.success).toBe(false);
    if (both.success) {
      return;
    }
    expect(JSON.stringify(both.error.issues)).toContain(
      VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
    );
  });

  it("does not coerce omit-both to base and keeps EntityRef unions", () => {
    expect(
      createOrderContract.input.parse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            quantity: { milli: "1000" },
          },
        ],
      }),
    ).toEqual({
      customer: { by: "id", id: validId },
      items: [
        {
          product: { by: "id", id: productId },
          quantity: { milli: "1000" },
        },
      ],
    });
    const source = readFileSync(
      new URL("./create.contract.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("discriminatedUnion");
    expect(source).toContain("entityRefSchema");
    expect(source).not.toContain("@showzy/catalog");
  });

  it("rejects companyId, empty items, duplicate raw refs, and invalid decimal", () => {
    expect(
      createOrderContract.input.safeParse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            quantity: { milli: "1000" },
          },
        ],
        companyId: validId,
      }).success,
    ).toBe(false);
    expect(
      createOrderContract.input.safeParse({
        customer: { by: "id", id: validId },
        items: [],
      }).success,
    ).toBe(false);
    expect(
      createOrderContract.input.safeParse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: productId },
            quantity: { milli: "2000" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      createOrderContract.input.safeParse({
        customer: { by: "id", id: validId },
        items: [
          {
            product: { by: "id", id: productId },
            quantity: { decimal: "1.2345" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      createOrderContract.output.safeParse({
        orderId: validId,
        orderNumber: "KA-1",
        customer: { nameSnapshot: "Katya", linkedCustomerId: validId },
        status: "new",
        itemCount: 1,
        totalNetMinor: "1000",
        totalTaxMinor: "0",
        totalGrossMinor: "1000",
        currency: "UAH",
        createdAt: "2026-08-29T12:00:00.000Z",
        items: [],
      }).success,
    ).toBe(false);
  });

  it("resolves CRM and catalog via ctx.call and persists only UUIDs + milli", () => {
    const handler = readFileSync(
      new URL("./create.ts", import.meta.url),
      "utf8",
    );
    const draft = readFileSync(
      new URL("../services/create-draft.ts", import.meta.url),
      "utf8",
    );
    const persist = readFileSync(
      new URL("../services/create-order.ts", import.meta.url),
      "utf8",
    );
    expect(handler).toContain("resolveCreateOrderDraft");
    expect(draft).toContain("resolveCustomerReference");
    expect(draft).toContain("resolveLineReferences");
    expect(draft).toContain("toCatalogLineInput");
    expect(draft).toContain('kind: "reference"');
    expect(draft).not.toContain("getProductOrderFacts");
    expect(draft).not.toMatch(/\bgetCustomer\b/);
    expect(draft).not.toMatch(/kind:\s*"base"/);
    expect(persist).not.toContain("EntityRef");
    expect(persist).not.toMatch(/by:\s*"query"/);
  });
});
