import { describe, expect, it } from "vitest";

import { AI_BUDGET_TTL_SEC, createMemoryAiBudgetStore } from "./budget.js";

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

  it("allows only one overlapping tryAdd when remaining budget fits one turn", async () => {
    const store = createMemoryAiBudgetStore();
    const key = "ai-budget:c:2026-09-02";
    const [first, second] = await Promise.all([
      store.tryAdd(key, 0.1, 0.1, AI_BUDGET_TTL_SEC),
      store.tryAdd(key, 0.1, 0.1, AI_BUDGET_TTL_SEC),
    ]);
    const allowed = [first, second].filter((decision) => decision.allowed);
    expect(allowed).toHaveLength(1);
    expect(await store.read(key)).toBeCloseTo(0.1);
  });
});
