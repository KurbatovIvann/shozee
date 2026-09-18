import { describe, expect, it } from "vitest";

import { scoreCall } from "./score.js";

const expected = {
  tool: "orders_create",
  args: { customerQuery: "Олена Петренко", items: ["2×капучино"] },
};

describe("scoreCall", () => {
  it("accepts another case of the same name and the same order lines", () => {
    expect(
      scoreCall(
        { expected },
        {
          tool: "orders_create",
          args: { customerQuery: "Олени Петренко", items: ["2×Капучино"] },
        },
      ),
    ).toEqual({ toolCorrect: true, correct: true, detour: false });
  });

  it("rejects a wrong quantity, a missing argument and an argument nobody asked for", () => {
    expect(
      scoreCall(
        { expected },
        {
          tool: "orders_create",
          args: { customerQuery: "Олена Петренко", items: ["3×капучино"] },
        },
      ).correct,
    ).toBe(false);
    expect(
      scoreCall(
        { expected: { tool: "orders_list_counts", args: { period: "today" } } },
        { tool: "orders_list_counts", args: {} },
      ),
    ).toEqual({ toolCorrect: true, correct: false, detour: false });
    expect(
      scoreCall(
        { expected: { tool: "orders_list_counts", args: {} } },
        { tool: "orders_list_counts", args: { statuses: ["new"], period: "" } },
      ).correct,
    ).toBe(false);
  });

  it("compares phones by their national digits and prices as numbers", () => {
    expect(
      scoreCall(
        {
          expected: {
            tool: "customers_createCustomer",
            args: { name: "Андрій Коваль", phone: "0501112233" },
          },
        },
        {
          tool: "customers_createCustomer",
          args: { name: "Андрій Коваль", phone: "+380501112233" },
        },
      ).correct,
    ).toBe(true);
    expect(
      scoreCall(
        {
          expected: {
            tool: "catalog_createProduct",
            args: { name: "Лате", basePriceMinor: "6500" },
          },
        },
        {
          tool: "catalog_createProduct",
          args: { name: "Лате", basePriceMinor: 6500 },
        },
      ).correct,
    ).toBe(true);
  });

  it("accepts the nominative for an inflected name, and calls a read before a write a detour", () => {
    expect(
      scoreCall(
        {
          expected: {
            tool: "customers_list_customers",
            args: { search: "Тарас Мельник" },
          },
        },
        {
          tool: "customers_list_customers",
          args: { search: "тараса мельника" },
        },
      ).correct,
    ).toBe(true);
    expect(
      scoreCall(
        { expected },
        { tool: "search_query", args: {} },
        new Set(["search_query"]),
      ),
    ).toEqual({ toolCorrect: false, correct: false, detour: true });
  });

  it("expects no call for talk, and accepts a declared alternative", () => {
    expect(scoreCall({ expected: null }, null).correct).toBe(true);
    expect(
      scoreCall({ expected: null }, { tool: "orders_list_page", args: {} })
        .correct,
    ).toBe(false);
    expect(
      scoreCall(
        {
          expected: { tool: "a", args: {} },
          alsoOk: [{ tool: "b", args: {} }],
        },
        { tool: "b", args: {} },
      ).correct,
    ).toBe(true);
  });
});
