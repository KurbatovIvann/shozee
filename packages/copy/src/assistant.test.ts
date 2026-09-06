import { describe, expect, it } from "vitest";

import { sharedAssistantCopy } from "./assistant.js";

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

describe("shared assistant copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    const uk = sharedAssistantCopy("uk");
    const en = sharedAssistantCopy("en");
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

  it("does not absorb app-only leftover assistant keys", () => {
    const shared = sharedAssistantCopy("uk");
    expect("sheetTitle" in shared).toBe(false);
    expect("emptyTitle" in shared).toBe(false);
    expect("waitLabel" in shared).toBe(false);
    expect("jobs" in shared).toBe(false);
    expect("errors" in shared).toBe(false);
    expect("openOrder" in shared.ordersList).toBe(false);
    expect("orderCount" in shared.ordersList).toBe(false);
    expect("noneBucket" in shared.ordersList).toBe(false);
    expect("aggregateEmptyTitle" in shared.ordersList).toBe(false);
    expect("periodToday" in shared.ordersList).toBe(false);
    expect("openOrder" in shared.customersList).toBe(false);
    expect("customerMatchTruncated" in shared.customersList).toBe(false);
  });
});
