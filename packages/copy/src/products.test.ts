import { describe, expect, it } from "vitest";

import { leafAt, leafPaths } from "./leaf-paths.js";
import { sharedProductsCopy } from "./products.js";

describe("shared products copy", () => {
  it("keeps uk/en key parity across the wholesale tree", () => {
    const uk = sharedProductsCopy("uk");
    const en = sharedProductsCopy("en");
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

  it("owns list, form, detail, and photos trees", () => {
    const shared = sharedProductsCopy("uk");
    expect("title" in shared).toBe(true);
    expect("filters" in shared).toBe(true);
    expect("empty" in shared).toBe(true);
    expect("stub" in shared).toBe(true);
    expect("form" in shared).toBe(true);
    expect("detail" in shared).toBe(true);
    expect("photos" in shared).toBe(true);
    expect("errors" in shared.form).toBe(true);
    expect("errors" in shared.photos).toBe(true);
  });

  it("keeps product-form chrome overrides, not the generic chrome verbs", () => {
    const uk = sharedProductsCopy("uk");
    const en = sharedProductsCopy("en");
    expect(en.form.changedLabel).toBe("changed");
    expect(en.form.submitCreate).toBe("Create product");
    expect(en.form.submitCreateLoading).toBe("Creating…");
    expect(uk.form.submitCreate).toBe("Створити товар");
    expect(uk.form.submitCreateLoading).toBe("Створюємо…");
    expect(uk.form.submitEditLoading).toBe("Зберігаємо…");
  });
});
