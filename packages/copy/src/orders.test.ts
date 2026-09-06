import { describe, expect, it } from "vitest";

import { sharedOrdersCopy } from "./orders.js";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return prefix === "" ? [] : [prefix];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix === "" ? [] : [prefix];
  }
  return entries.flatMap(([key, child]) =>
    leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("shared orders copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    const uk = sharedOrdersCopy("uk");
    const en = sharedOrdersCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = path.split(".").reduce<unknown>((current, key) => {
        if (current === null || typeof current !== "object") {
          return undefined;
        }
        return (current as Record<string, unknown>)[key];
      }, uk);
      const enValue = path.split(".").reduce<unknown>((current, key) => {
        if (current === null || typeof current !== "object") {
          return undefined;
        }
        return (current as Record<string, unknown>)[key];
      }, en);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("does not absorb app-only or wording-divergent keys", () => {
    const shared = sharedOrdersCopy("uk");
    expect("createLabel" in shared).toBe(false);
    expect("filterAll" in shared).toBe(false);
    expect("filterLabel" in shared).toBe(false);
    expect("emptySelection" in shared).toBe(false);
    expect("loadingMoreLabel" in shared).toBe(false);
    expect("offlineTitle" in shared.empty).toBe(false);
    expect("catalogDescription" in shared.empty).toBe(false);
    expect("catalogAction" in shared.empty).toBe(false);
    expect("create" in shared.empty).toBe(false);
    expect("backLabel" in shared.detail).toBe(false);
    expect("offlineTitle" in shared.detail).toBe(false);
    expect("completeLabel" in shared.detail).toBe(false);
    expect("actionsTitle" in shared.detail).toBe(false);
    expect("notFoundAction" in shared.detail).toBe(false);
    expect("addProductsLabel" in shared.create).toBe(false);
    expect("productSheetDone" in shared.create).toBe(false);
    expect("productSheetAdd" in shared.create).toBe(false);
    expect("noVariants" in shared.create).toBe(false);
    expect("variantsNone" in shared.create).toBe(false);
  });
});
