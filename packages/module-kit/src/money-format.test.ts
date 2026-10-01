import { CoreInvariantError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import {
  formatMinorUnits,
  formatMoneyMinor,
  formatMoneyUah,
  formatQuantityMilli,
} from "./money-format.js";

describe("money formatting (money.md minor units)", () => {
  it("renders minor units with a comma and grouped thousands", () => {
    expect(formatMinorUnits("250", 2)).toBe("2,50");
    expect(formatMinorUnits("100000", 2)).toBe("1 000,00");
    expect(formatMinorUnits("-5", 2)).toBe("-0,05");
  });

  it("suffixes UAH in Ukrainian and other currencies by code", () => {
    expect(formatMoneyUah("51875")).toBe("518,75 грн");
    expect(formatMoneyMinor("51875", "UAH")).toBe("518,75 грн");
    expect(formatMoneyMinor("51875", "EUR")).toBe("518,75 EUR");
  });

  it("rejects a value that is not a canonical minor-unit string", () => {
    expect(() => formatMinorUnits("1.5", 2)).toThrow(CoreInvariantError);
    expect(() => formatQuantityMilli("0")).toThrow(CoreInvariantError);
  });

  it("drops trailing zero fractions from quantity_milli", () => {
    expect(formatQuantityMilli("2000")).toBe("2");
    expect(formatQuantityMilli("1500")).toBe("1,5");
    expect(formatQuantityMilli("1234567")).toBe("1 234,567");
  });
});
