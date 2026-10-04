import { describe, expect, it } from "vitest";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_ARRAY_MAX,
  STAFF_ASSISTANT_CLIP_IDENTITY_KEYS,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "./clip-tool-result.js";

const customerId = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_NAME = "Олена Коваль";
const orderId = "44444444-4444-4444-8444-444444444444";

function rowId(index: number): string {
  return `33333333-3333-4333-8333-${index.toString(16).padStart(12, "0")}`;
}

function itemId(index: number): string {
  return `55555555-5555-4555-8555-${index.toString(16).padStart(12, "0")}`;
}

function isClipped(value: unknown): value is {
  status: string;
  preview: unknown;
  omitted: number;
  cutPaths: readonly string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === STAFF_ASSISTANT_CLIPPED_STATUS
  );
}

describe("clipStaffAssistantToolResult", () => {
  it("passes typed error objects through unchanged", () => {
    const error = {
      status: "error",
      code: "NOT_FOUND",
      message: "Customer not found.",
    };
    expect(clipStaffAssistantToolResult(error)).toBe(error);
    const archived = {
      status: "error",
      code: "CONFLICT",
      message: '"Old Widget" is archived.',
      reason: "archived",
      subject: { kind: "product_name", name: "Old Widget" },
    };
    expect(clipStaffAssistantToolResult(archived)).toBe(archived);
    expect(archived.reason).toBe("archived");
    expect(archived.subject).toEqual({
      kind: "product_name",
      name: "Old Widget",
    });
  });

  it("does not clip a small create-style write result", () => {
    const created = { customerId };
    expect(clipStaffAssistantToolResult(created)).toBe(created);
  });

  it("does not wrap a single-record get that already fits the JSON cap", () => {
    const get = {
      orderId,
      orderNumber: "A-1",
      customerId,
      status: "new",
      items: [
        {
          itemId: itemId(0),
          titleSnapshot: "Seed",
        },
      ],
    };
    expect(clipStaffAssistantToolResult(get)).toBe(get);
  });

  it("clips a list longer than the array cap and reports omitted", () => {
    const items = Array.from(
      { length: STAFF_ASSISTANT_CLIP_ARRAY_MAX + 30 },
      (_, index) => ({
        orderId: rowId(index),
      }),
    );
    const clipped = clipStaffAssistantToolResult({
      items,
      nextCursor: null,
    });
    expect(clipped).toEqual({
      status: STAFF_ASSISTANT_CLIPPED_STATUS,
      preview: {
        items: items.slice(0, STAFF_ASSISTANT_CLIP_ARRAY_MAX),
        nextCursor: null,
      },
      omitted: 30,
      cutPaths: ["items"],
    });
  });

  it("names the array it cut and stays silent about a full array it kept", () => {
    const variants = Array.from(
      { length: STAFF_ASSISTANT_CLIP_ARRAY_MAX },
      (_, index) => ({ id: rowId(index) }),
    );
    expect(
      clipStaffAssistantToolResult({
        id: rowId(0),
        variants,
        imageFileIds: Array.from(
          { length: STAFF_ASSISTANT_CLIP_ARRAY_MAX + 4 },
          (_, index) => String(index),
        ),
      }),
    ).toEqual(
      expect.objectContaining({
        status: STAFF_ASSISTANT_CLIPPED_STATUS,
        cutPaths: ["imageFileIds"],
      }),
    );
  });

  it("names a dropped row key by its array path", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      itemId: itemId(index),
      qty: index,
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(clipped.cutPaths).toContain("items.qty");
    expect(clipped.cutPaths).toContain("items.notes");
    expect(clipped.cutPaths).not.toContain("items.itemId");
  });

  it("names a cut of the root array as the empty path", () => {
    const clipped = clipStaffAssistantToolResult(
      Array.from({ length: STAFF_ASSISTANT_CLIP_ARRAY_MAX + 1 }, (_, index) =>
        rowId(index),
      ),
    );
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(clipped.cutPaths).toEqual([""]);
  });

  it("names a key the shrink dropped", () => {
    const clipped = clipStaffAssistantToolResult({
      id: rowId(0),
      comment: "c".repeat(STAFF_ASSISTANT_CLIP_JSON_MAX),
      variants: [{ id: rowId(1) }, { id: rowId(2) }, { id: rowId(3) }],
    });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(clipped.cutPaths).toContain("comment");
    expect(clipped.cutPaths).not.toContain("variants");
  });

  it("keeps order identity and a titleSnapshot on an oversized get", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      itemId: itemId(index),
      productId: rowId(index),
      variantId: null,
      titleSnapshot: `Line ${String(index)}`,
      notes: "n".repeat(200),
      quantityMilli: "1000",
      unitPriceMinor: "100",
      netAmountMinor: "100",
      grossAmountMinor: "100",
      currency: "UAH",
    }));
    const get = {
      orderId,
      orderNumber: "A-99",
      customer: { nameSnapshot: CUSTOMER_NAME, linkedCustomerId: customerId },
      status: "confirmed",
      comment: "c".repeat(STAFF_ASSISTANT_CLIP_JSON_MAX),
      notes: "n".repeat(800),
      items,
    };
    const clipped = clipStaffAssistantToolResult(get);
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(clipped.preview).not.toEqual({ truncated: true });
    expect(clipped.preview).toEqual(
      expect.objectContaining({
        orderId,
        orderNumber: "A-99",
        customer: { nameSnapshot: CUSTOMER_NAME, linkedCustomerId: customerId },
        status: "confirmed",
      }),
    );
    const preview = clipped.preview;
    expect(typeof preview === "object" && preview !== null).toBe(true);
    const previewItems =
      typeof preview === "object" &&
      preview !== null &&
      "items" in preview &&
      Array.isArray(preview.items)
        ? preview.items
        : [];
    expect(previewItems.length).toBeGreaterThan(0);
    expect(previewItems[0]).toEqual(
      expect.objectContaining({
        itemId: itemId(0),
        titleSnapshot: "Line 0",
      }),
    );
    expect(JSON.stringify(clipped.preview)).toContain("titleSnapshot");
  });

  it("never uses { truncated: true } as the whole preview", () => {
    const body = "x".repeat(STAFF_ASSISTANT_CLIP_JSON_MAX + 80);
    const clipped = clipStaffAssistantToolResult({ body, orderId });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(clipped.preview).not.toEqual({ truncated: true });
    expect(clipped.preview).toEqual(expect.objectContaining({ orderId }));
    expect(
      typeof clipped.preview === "object" &&
        clipped.preview !== null &&
        "body" in clipped.preview,
    ).toBe(false);
  });

  it("keeps the nested order customer on identity-key shrink", () => {
    expect(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS).toEqual(
      expect.arrayContaining(["customer"]),
    );
    const items = Array.from({ length: 40 }, (_, index) => ({
      orderId: rowId(index),
      orderNumber: `A-${String(index)}`,
      customer: {
        nameSnapshot: CUSTOMER_NAME,
        linkedCustomerId: customerId,
      },
      status: "new",
      itemCount: 1,
      totalGrossMinor: "1000",
      currency: "UAH",
      createdAt: "2026-02-01T09:00:00.000Z",
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items, nextCursor: null });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    const previewItems =
      typeof clipped.preview === "object" &&
      clipped.preview !== null &&
      "items" in clipped.preview &&
      Array.isArray(clipped.preview.items)
        ? clipped.preview.items
        : [];
    expect(previewItems[0]).toEqual(
      expect.objectContaining({
        customer: {
          nameSnapshot: CUSTOMER_NAME,
          linkedCustomerId: customerId,
        },
      }),
    );
    expect(clipped.cutPaths).not.toContain("items.customer");
  });

  it("keeps catalog money snapshots on identity-key shrink", () => {
    expect(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS).toEqual(
      expect.arrayContaining(["basePriceMinor", "currency"]),
    );
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: rowId(index),
      name: `N${"x".repeat(110)}`,
      basePriceMinor: String(10_000 + index),
      currency: "UAH",
      status: "active",
      variantCount: 1,
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items, nextCursor: null });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(JSON.stringify(clipped.preview)).toContain("basePriceMinor");
    expect(JSON.stringify(clipped.preview)).toContain("UAH");
  });

  it("keeps list-card marker and count facts on identity-key shrink", () => {
    expect(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS).toEqual(
      expect.arrayContaining([
        "isActive",
        "isDefault",
        "entryCount",
        "variantCount",
      ]),
    );
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: rowId(index),
      name: `N${"x".repeat(110)}`,
      isDefault: index === 0,
      isActive: index !== 1,
      entryCount: index,
      variantCount: index,
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items, nextCursor: null });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    const previewItems =
      typeof clipped.preview === "object" &&
      clipped.preview !== null &&
      "items" in clipped.preview &&
      Array.isArray(clipped.preview.items)
        ? clipped.preview.items
        : [];
    expect(previewItems[0]).toEqual(
      expect.objectContaining({
        isDefault: true,
        isActive: true,
        entryCount: 0,
        variantCount: 0,
      }),
    );
    expect(previewItems[1]).toEqual(
      expect.objectContaining({ isActive: false }),
    );
  });

  it("keeps price-list entry references and the price on identity-key shrink", () => {
    expect(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS).toEqual(
      expect.arrayContaining(["productId", "variantId", "priceMinor"]),
    );
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: rowId(index),
      priceListId: rowId(900),
      productId: rowId(index + 100),
      variantId: index === 0 ? rowId(index + 200) : null,
      priceMinor: String(10_000 + index),
      currency: "UAH",
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items, nextCursor: null });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    const previewItems =
      typeof clipped.preview === "object" &&
      clipped.preview !== null &&
      "items" in clipped.preview &&
      Array.isArray(clipped.preview.items)
        ? clipped.preview.items
        : [];
    expect(previewItems[0]).toEqual(
      expect.objectContaining({
        id: rowId(0),
        priceListId: rowId(900),
        productId: rowId(100),
        variantId: rowId(200),
        priceMinor: "10000",
        currency: "UAH",
      }),
    );
    expect(previewItems[1]).toEqual(
      expect.objectContaining({ variantId: null }),
    );
  });

  it("keeps CRM contacts on identity-key shrink", () => {
    expect(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS).toEqual(
      expect.arrayContaining(["phone", "email", "groupId", "priceListId"]),
    );
    const groupId = "66666666-6666-4666-8666-666666666666";
    const priceListId = "77777777-7777-4777-8777-777777777777";
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: rowId(index),
      name: `N${"x".repeat(110)}`,
      phone: "+380501234567",
      email: `c${String(index)}@example.com`,
      status: "active",
      groupId,
      priceListId,
      notes: "n".repeat(800),
    }));
    const clipped = clipStaffAssistantToolResult({ items, nextCursor: null });
    expect(isClipped(clipped)).toBe(true);
    if (!isClipped(clipped)) {
      return;
    }
    expect(JSON.stringify(clipped.preview)).toContain("+380501234567");
    expect(JSON.stringify(clipped.preview)).toContain("@example.com");
    expect(JSON.stringify(clipped.preview)).toContain(groupId);
    expect(JSON.stringify(clipped.preview)).toContain(priceListId);
  });

  it("clips a payload at the stringify 22000 bound that would fail jsonb::text CHECK", () => {
    const payload = { pad: "x".repeat(21_990) };
    expect(JSON.stringify(payload).length).toBe(STAFF_ASSISTANT_CLIP_JSON_MAX);
    const clipped = clipStaffAssistantToolResult(payload);
    expect(isClipped(clipped)).toBe(true);
  });
});
