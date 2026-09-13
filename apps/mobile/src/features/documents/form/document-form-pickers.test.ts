import { describe, expect, it } from "vitest";

import {
  counterpartyPickerEnabled,
  documentCounterpartyOptionDescription,
  documentOrderOptionDescription,
  documentOrderOptionName,
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
} from "./document-form-pickers";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

const ORDER = {
  orderId: ORDER_ID,
  orderNumber: "KA-K7X2",
  customer: {
    nameSnapshot: "Customer A",
    linkedCustomerId: ORDER_ID,
  },
  status: "confirmed" as const,
  itemCount: 1,
  totalGrossMinor: "123456",
  currency: "UAH",
  createdAt: "2026-08-29T12:00:00.000Z",
};

describe("document form pickers", () => {
  it("labels an order with the customer as primary and number plus total as subtitle", () => {
    expect(documentOrderOptionName(ORDER, "Deleted customer")).toBe(
      "Customer A",
    );
    expect(documentOrderOptionDescription(ORDER)).toContain("#KA-K7X2");
    expect(documentOrderOptionDescription(ORDER)).toContain("₴");
  });

  it("localizes the unlinked snapshot", () => {
    const unlinked = {
      ...ORDER,
      customer: {
        nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        linkedCustomerId: null,
      },
    };
    expect(documentOrderOptionName(unlinked, "Клієнт видалений")).toBe(
      "Клієнт видалений",
    );
  });

  it("uses edrpou as the counterparty subtitle when present", () => {
    expect(documentCounterpartyOptionDescription({ edrpou: "12345678" })).toBe(
      "12345678",
    );
    expect(documentCounterpartyOptionDescription({ edrpou: null })).toBeNull();
    expect(documentCounterpartyOptionDescription({ edrpou: "" })).toBeNull();
  });

  it("enables the counterparty picker only for an order with a customer", () => {
    expect(counterpartyPickerEnabled({ orderId: "", customerId: null })).toBe(
      false,
    );
    expect(
      counterpartyPickerEnabled({ orderId: ORDER_ID, customerId: null }),
    ).toBe(false);
    expect(
      counterpartyPickerEnabled({ orderId: ORDER_ID, customerId: ORDER_ID }),
    ).toBe(true);
  });
});
