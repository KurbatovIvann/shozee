import { describe, expect, it } from "vitest";

import { countPluralForm } from "./plural.js";

describe("countPluralForm", () => {
  it("applies Ukrainian one/few/many including teen exceptions", () => {
    expect(countPluralForm(1, "uk")).toBe("one");
    expect(countPluralForm(21, "uk")).toBe("one");
    expect(countPluralForm(2, "uk")).toBe("few");
    expect(countPluralForm(4, "uk")).toBe("few");
    expect(countPluralForm(22, "uk")).toBe("few");
    expect(countPluralForm(5, "uk")).toBe("many");
    expect(countPluralForm(11, "uk")).toBe("many");
    expect(countPluralForm(12, "uk")).toBe("many");
    expect(countPluralForm(14, "uk")).toBe("many");
  });

  it("applies English one/other (other maps to many)", () => {
    expect(countPluralForm(1, "en")).toBe("one");
    expect(countPluralForm(2, "en")).toBe("many");
    expect(countPluralForm(21, "en")).toBe("many");
  });
});
