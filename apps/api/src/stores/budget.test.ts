import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_TTL_SEC,
  createMemoryAiBudgetStore,
} from "./budget.js";

describe("createMemoryAiBudgetStore", () => {
  it("reads 0 for a missing key and adds spend with TTL", async () => {
    let nowMs = 1_000_000;
    const store = createMemoryAiBudgetStore({ now: () => nowMs });
    expect(await store.read("ai-budget:c:2026-09-02")).toBe(0);
    expect(
      await store.add("ai-budget:c:2026-09-02", 0.42, AI_BUDGET_TTL_SEC),
    ).toBeCloseTo(0.42);
    expect(await store.read("ai-budget:c:2026-09-02")).toBeCloseTo(0.42);
    nowMs += AI_BUDGET_TTL_SEC * 1000 + 1;
    expect(await store.read("ai-budget:c:2026-09-02")).toBe(0);
  });
});
