import { describe, expect, it } from "vitest";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_ARRAY_MAX,
  STAFF_ASSISTANT_CLIP_IDENTITY_KEYS,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "./clip-tool-result.js";
import { STAFF_ASSISTANT_CONFIRMATION_STATUS } from "./confirmation.js";
import { STAFF_ASSISTANT_NEEDS_CHOICE_STATUS } from "./choice.js";
import { extractUuidResultIds } from "./staff-assistant-stream.js";

const customerId = "11111111-1111-4111-8111-111111111111";
const orderId = "44444444-4444-4444-8444-444444444444";
const challengeId = "22222222-2222-4222-8222-222222222222";

function rowId(index: number): string {
  return `33333333-3333-4333-8333-${index.toString(16).padStart(12, "0")}`;
}

function itemId(index: number): string {
  return `55555555-5555-4555-8555-${index.toString(16).padStart(12, "0")}`;
}

function isClipped(
  value: unknown,
): value is { status: string; preview: unknown; omitted: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === STAFF_ASSISTANT_CLIPPED_STATUS
  );
}

describe("clipStaffAssistantToolResult", () => {
  it("passes confirmation payloads through unchanged", () => {
    const confirmation = {
      status: STAFF_ASSISTANT_CONFIRMATION_STATUS,
      challengeId,
      summary: "Delete this archived customer.",
      expiresAt: "2026-09-01T12:00:00.000Z",
      actionName: "customers.deleteCustomer",
      toolCallId: "call-delete",
    };
    expect(clipStaffAssistantToolResult(confirmation)).toBe(confirmation);
  });

  it("passes needs_choice payloads through unchanged", () => {
    const needsChoice = {
      status: STAFF_ASSISTANT_NEEDS_CHOICE_STATUS,
      challengeId,
      reason: "variant_required",
      productName: "Macarons",
      options: [{ id: challengeId, label: "Lemon" }],
      optionsTruncated: false,
    };
    expect(clipStaffAssistantToolResult(needsChoice)).toBe(needsChoice);
  });

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
    expect(extractUuidResultIds({ customerId })).toEqual([customerId]);
    expect(extractUuidResultIds({ id: customerId })).toEqual([customerId]);
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
    });
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
      customerId,
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
        customerId,
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
});
