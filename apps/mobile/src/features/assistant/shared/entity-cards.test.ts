import {
  ASSISTANT_TOOL_CLIPPED_STATUS,
  assistantSurfaceHandoffHref,
  parseCustomerEntitySurfaces,
  parseProductEntitySurfaces,
  type AssistantCustomerEntityData,
  type AssistantProductEntityData,
  type AssistantSurfaceToolResult,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { formatMoneyMinor } from "../../../format/money";
import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import { productsCopy } from "../../../i18n/products";
import { productPhotoHref } from "../../catalog/products/shared/product-hrefs";
import { variantCountLabel } from "../../catalog/products/shared/variant-count";
import { customerEditorHref } from "../../customers/shared/customer-hrefs";
import {
  assistantSurfaceKey,
  localizeAssistantCardPayload,
  localizeCustomerEntityCard,
  localizeProductEntityCard,
} from "../surfaces";
import { assistantRecordHref } from "./assistant-record-hrefs";

const CUSTOMER_ID = "2b3c4d5e-6f70-4891-9bcd-ef0123456789";
const PRODUCT_ID = "3c4d5e6f-7081-49a2-8cde-f01234567890";

function result(
  toolName: string,
  output: unknown,
  toolCallId?: string,
): AssistantSurfaceToolResult {
  if (toolCallId === undefined) {
    return { toolName, output };
  }
  return { toolName, output, toolCallId };
}

function customerData(
  payload: Record<string, unknown>,
  toolCallId?: string,
): AssistantCustomerEntityData {
  const [entity] = parseCustomerEntitySurfaces([
    result("customers_get_customer", payload, toolCallId),
  ]);
  if (entity === undefined) {
    throw new Error("customer entity payload did not parse");
  }
  return entity;
}

function productData(
  output: unknown,
  toolCallId?: string,
): AssistantProductEntityData {
  const [entity] = parseProductEntitySurfaces([
    result("catalog_get_product", output, toolCallId),
  ]);
  if (entity === undefined) {
    throw new Error("product entity payload did not parse");
  }
  return entity;
}

describe("customer entity card (SHO-756)", () => {
  it("shows contacts as detail rows and opens the customer record", () => {
    const card = localizeCustomerEntityCard(
      customerData(
        {
          id: CUSTOMER_ID,
          name: "Катя Самбука",
          phone: "+380671112233",
          email: "katya@example.com",
          status: "active",
        },
        "call-1",
      ),
      "uk",
    );

    expect(card.title).toBe("Катя Самбука");
    expect(card.detailRows).toEqual(["+380671112233", "katya@example.com"]);
    expect(card.valueLabel).toBeNull();
    expect(card.statusLabel).toBeNull();
    expect(card.footnotes).toEqual([]);
    expect(card.id).toBe("call-1");
    expect(card.href).toBe(customerEditorHref(CUSTOMER_ID));
    expect(card.href).toBe(assistantRecordHref("customer", CUSTOMER_ID));
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openCustomer);
  });

  it("builds the handoff destination from the same record map as the body", () => {
    const card = localizeCustomerEntityCard(
      customerData({ id: CUSTOMER_ID, name: "Катя Самбука" }),
      "uk",
    );

    expect(assistantSurfaceHandoffHref(card.destination)).toBe(card.href);
    expect(card.destination).toEqual({
      kind: "screen",
      href: assistantRecordHref("customer", CUSTOMER_ID),
    });
  });

  it("pills an archived customer and keeps the record reachable", () => {
    const card = localizeCustomerEntityCard(
      customerData({
        id: CUSTOMER_ID,
        name: "Катя Самбука",
        phone: null,
        email: null,
        status: "archived",
      }),
      "uk",
    );

    expect(card.statusLabel).toBe(customersCopy("uk").archivedBadge);
    expect(card.statusTone).toBe("attention");
    expect(card.detailRows).toEqual([]);
    expect(card.id).toBe(`customer-entity:${CUSTOMER_ID}`);
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openCustomer);
  });

  it("falls back to the record id when the payload carries no name", () => {
    const card = localizeCustomerEntityCard(
      customerData({ id: CUSTOMER_ID }),
      "uk",
    );

    expect(card.title).toBe(CUSTOMER_ID);
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openCustomer);
  });
});

describe("product entity card (SHO-756)", () => {
  it("shows the variant count and base price and opens the product record", () => {
    const card = localizeProductEntityCard(
      productData(
        {
          id: PRODUCT_ID,
          name: "Наполеон",
          basePriceMinor: "45000",
          currency: "UAH",
          status: "active",
          variants: [{ id: PRODUCT_ID }, { id: CUSTOMER_ID }],
        },
        "call-2",
      ),
      "uk",
    );

    expect(card.title).toBe("Наполеон");
    expect(card.detailRows).toEqual([
      variantCountLabel(2, "uk", productsCopy("uk").variants),
    ]);
    expect(card.valueLabel).toBe(formatMoneyMinor("45000", "UAH"));
    expect(card.footnotes).toEqual([]);
    expect(card.id).toBe("call-2");
    expect(card.href).toBe(productPhotoHref(PRODUCT_ID));
    expect(card.href).toBe(assistantRecordHref("product", PRODUCT_ID));
    expect(assistantSurfaceHandoffHref(card.destination)).toBe(card.href);
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openProduct);
  });

  it("pills an archived product and still counts its variants", () => {
    const card = localizeProductEntityCard(
      productData({
        id: PRODUCT_ID,
        name: "Наполеон",
        status: "archived",
        variants: [],
      }),
      "en",
    );

    expect(card.statusLabel).toBe(productsCopy("en").archivedBadge);
    expect(card.statusTone).toBe("attention");
    expect(card.detailRows).toEqual([productsCopy("en").variants.none]);
    expect(card.valueLabel).toBeNull();
    expect(card.id).toBe(`product-entity:${PRODUCT_ID}`);
  });

  it("drops the variant count and footnotes the clip when the array was cut", () => {
    const card = localizeProductEntityCard(
      productData({
        status: ASSISTANT_TOOL_CLIPPED_STATUS,
        omitted: 23,
        preview: {
          id: PRODUCT_ID,
          name: "Наполеон",
          basePriceMinor: "45000",
          currency: "UAH",
          variants: Array.from({ length: 50 }, (_, index) => ({
            id: String(index),
          })),
        },
      }),
      "uk",
    );

    expect(card.detailRows).toEqual([]);
    expect(card.footnotes).toEqual([assistantCopy("uk").cards.variantsClipped]);
    expect(card.valueLabel).toBe(formatMoneyMinor("45000", "UAH"));
    expect(card.title).toBe("Наполеон");
  });
});

describe("stored entity card payloads (SHO-756)", () => {
  it("localizes both kinds back from the stored payload under their own key", () => {
    const customer = localizeAssistantCardPayload(
      "customer-entity",
      customerData({ id: CUSTOMER_ID, name: "Катя Самбука" }, "call-1"),
      "uk",
    );
    const product = localizeAssistantCardPayload(
      "product-entity",
      productData({ id: PRODUCT_ID, name: "Наполеон" }, "call-2"),
      "uk",
    );

    expect(customer?.kind).toBe("customer-entity");
    expect(product?.kind).toBe("product-entity");
    if (customer === null || product === null) return;
    expect(assistantSurfaceKey(customer)).toBe("call-1");
    expect(assistantSurfaceKey(product)).toBe("call-2");
  });
});
