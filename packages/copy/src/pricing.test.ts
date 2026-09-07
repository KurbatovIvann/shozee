import { describe, expect, it } from "vitest";

import { leafAt, leafPaths } from "./leaf-paths.js";
import { sharedPricingCopy } from "./pricing.js";

describe("shared pricing copy", () => {
  it("keeps uk/en key parity across the wholesale tree", () => {
    const uk = sharedPricingCopy("uk");
    const en = sharedPricingCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = leafAt(uk, path);
      const enValue = leafAt(en, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("owns list, options, confirm, mutation, and form trees", () => {
    const shared = sharedPricingCopy("uk");
    expect("title" in shared).toBe(true);
    expect("filters" in shared).toBe(true);
    expect("prices" in shared).toBe(true);
    expect("empty" in shared).toBe(true);
    expect("options" in shared).toBe(true);
    expect("confirm" in shared).toBe(true);
    expect("toast" in shared).toBe(true);
    expect("mutation" in shared).toBe(true);
    expect("form" in shared).toBe(true);
    expect("errors" in shared.form).toBe(true);
  });

  it("keeps price-list chrome overrides, not the generic chrome verbs", () => {
    const uk = sharedPricingCopy("uk");
    const en = sharedPricingCopy("en");
    expect(en.form.changedLabel).toBe("changed");
    expect(en.form.submitCreateLoading).toBe("Creating…");
    expect(uk.form.submitCreateLoading).toBe("Створення…");
    expect(en.form.errors.validation).toBe("Check the highlighted fields");
    expect(uk.form.errors.validation).toBe("Перевірте виділені поля");
    expect(en.form.cannotDeactivateDefault).toBe("Turn off “default” first");
    expect(uk.form.cannotDeactivateDefault).toBe(
      "Спочатку зніміть позначку «основний»",
    );
  });
});
