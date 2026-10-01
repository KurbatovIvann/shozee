import { describe, expect, it } from "vitest";

import {
  orderPreviewCommentLine,
  orderPreviewCustomerTitle,
  orderPreviewLine,
  orderPreviewPricesNote,
  orderPreviewTotalLine,
} from "./preview-card.js";

describe("order preview card copy", () => {
  it("states quantity, the price snapshot and the line total", () => {
    expect(
      orderPreviewLine({
        title: "Торт Наполеон · Великий",
        quantityMilli: "1500",
        unitPriceMinor: "25000",
        grossAmountMinor: "37500",
        currency: "UAH",
      }),
    ).toEqual({
      label: "Торт Наполеон · Великий",
      value: "1,5 × 250,00 грн = 375,00 грн",
    });
    expect(orderPreviewTotalLine("37500", "UAH")).toEqual({
      label: "Разом",
      value: "375,00 грн",
    });
  });

  it("names each distinct price source once", () => {
    expect(
      orderPreviewPricesNote([
        "personal",
        "default_price_list",
        "personal",
        "base",
      ]),
    ).toBe("Ціни: персональна ціна, основний прайс-лист, базова ціна");
  });

  it("names the customer in the nominative without nesting quotes", () => {
    expect(orderPreviewCustomerTitle("Нове замовлення", "Олена Коваль")).toBe(
      "Нове замовлення: Олена Коваль",
    );
  });

  it("shows the persisted comment and marks an empty one", () => {
    expect(orderPreviewCommentLine("  до 14:00  ")).toEqual({
      label: "Коментар",
      value: "до 14:00",
    });
    expect(orderPreviewCommentLine("   ")).toEqual({
      label: "Коментар",
      value: "—",
    });
  });
});
