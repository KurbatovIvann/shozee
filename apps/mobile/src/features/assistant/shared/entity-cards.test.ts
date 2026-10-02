import { readFileSync } from "node:fs";

import {
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
  payload: Record<string, unknown>,
  toolCallId?: string,
): AssistantProductEntityData {
  const [entity] = parseProductEntitySurfaces([
    result("catalog_get_product", payload, toolCallId),
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

    expect(card.name).toBe("Катя Самбука");
    expect(card.detailRows).toEqual(["+380671112233", "katya@example.com"]);
    expect(card.statusLabel).toBeNull();
    expect(card.id).toBe("call-1");
    expect(card.href).toBe(customerEditorHref(CUSTOMER_ID));
    expect(card.href).toBe(assistantRecordHref("customer", CUSTOMER_ID));
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openCustomer);
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

  it("renders a gone state with no handoff when the record has no name", () => {
    const card = localizeCustomerEntityCard(
      customerData({ id: CUSTOMER_ID, phone: "+380671112233" }),
      "uk",
    );

    expect(card.name).toBeNull();
    expect(card.goneLabel).toBe(assistantCopy("uk").cards.recordGone);
    expect(card.detailRows).toEqual([]);
    expect(card.handoffLabel).toBeNull();
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

    expect(card.name).toBe("Наполеон");
    expect(card.detailRows).toEqual([
      variantCountLabel(2, "uk", productsCopy("uk").variants),
    ]);
    expect(card.priceLabel).toBe(formatMoneyMinor("45000", "UAH"));
    expect(card.statusLabel).toBeNull();
    expect(card.id).toBe("call-2");
    expect(card.href).toBe(productPhotoHref(PRODUCT_ID));
    expect(card.href).toBe(assistantRecordHref("product", PRODUCT_ID));
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
    expect(card.priceLabel).toBeNull();
    expect(card.id).toBe(`product-entity:${PRODUCT_ID}`);
  });

  it("renders a gone state with no handoff, rows, or price", () => {
    const card = localizeProductEntityCard(
      productData({
        id: PRODUCT_ID,
        basePriceMinor: "45000",
        currency: "UAH",
        variants: [{ id: PRODUCT_ID }],
      }),
      "uk",
    );

    expect(card.name).toBeNull();
    expect(card.goneLabel).toBe(assistantCopy("uk").cards.recordGone);
    expect(card.detailRows).toEqual([]);
    expect(card.priceLabel).toBeNull();
    expect(card.handoffLabel).toBeNull();
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

describe("entity card components (SHO-756)", () => {
  const customerCard = readFileSync(
    new URL("../sheet/customer-entity-card.tsx", import.meta.url),
    "utf8",
  );
  const productCard = readFileSync(
    new URL("../sheet/product-entity-card.tsx", import.meta.url),
    "utf8",
  );
  const surfaceCard = readFileSync(
    new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
    "utf8",
  );

  it("renders a gone body before the pressable and pills through StatusPill", () => {
    for (const source of [customerCard, productCard]) {
      expect(source).toContain("card.name === null");
      expect(source).toContain("card.goneLabel");
      expect(source).toContain("StatusPill");
      expect(source).toContain("card.detailRows.map");
      expect(source).toContain("props.onOpenHref(card.href)");
      expect(source.includes("hex")).toBe(false);
    }
  });

  it("maps both entity kinds in the block switch", () => {
    expect(surfaceCard).toContain("CustomerEntityCard");
    expect(surfaceCard).toContain("ProductEntityCard");
    expect(surfaceCard).toContain('case "customer-entity":');
    expect(surfaceCard).toContain('case "product-entity":');
    expect(surfaceCard).toContain("isEntitySurface(surface)");
  });
});
