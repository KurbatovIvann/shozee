import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_FLOORED_MESSAGE,
  AI_BUDGET_TTL_SEC,
  aiBudgetHoldKey,
  aiCompanyBudgetKey,
  createMemoryAiBudgetStore,
} from "./budget.js";

/** A logger that keeps what it was told. */
function capturingLogger() {
  const warnings: { fields: Record<string, unknown>; message: string }[] = [];
  return {
    warnings,
    logger: {
      warn(fields: Record<string, unknown>, message: string) {
        warnings.push({ fields, message });
      },
    },
  };
}

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

  /** The Redis store must match this (SHO-561). */
  it("never leaves a counter below zero", async () => {
    const store = createMemoryAiBudgetStore();
    const key = "ai-budget:c:2026-09-11";
    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);

    expect(await store.add(key, -0.25, AI_BUDGET_TTL_SEC)).toBe(0);
    expect(await store.read(key)).toBe(0);
    expect(await store.add(key, -0.1, AI_BUDGET_TTL_SEC)).toBe(0);
    expect(await store.add(key, 0.1, AI_BUDGET_TTL_SEC)).toBeCloseTo(0.1);
    expect(
      (await store.tryAdd(key, 0.1, 0.15, AI_BUDGET_TTL_SEC)).allowed,
    ).toBe(false);
  });

  /** A double release, or a reset under turns in flight, must not vanish. */
  it("warns when a release stops a non-zero counter at zero, and only then", async () => {
    const { logger, warnings } = capturingLogger();
    const store = createMemoryAiBudgetStore({ logger });
    const key = "ai-budget:c:2026-09-11";

    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);
    await store.add(key, -0.05, AI_BUDGET_TTL_SEC);
    await store.add(key, -0.05, AI_BUDGET_TTL_SEC);
    expect(warnings).toEqual([]);

    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);
    await store.add(key, -0.25, AI_BUDGET_TTL_SEC);
    // A missing key has nothing to lose.
    await store.add(key, -0.1, AI_BUDGET_TTL_SEC);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(AI_BUDGET_FLOORED_MESSAGE);
    expect(warnings[0]?.fields).toEqual({
      budget_key: key,
      current_usd: expect.closeTo(0.1) as number,
      delta_usd: -0.25,
    });
  });
});

/**
 * The record a turn's reservation is kept under (SHO-572). The Redis store must
 * match this, and `budget-redis.db.test.ts` runs the same cases.
 */
describe("hold records in the memory store", () => {
  it("records a hold once and tells every later caller what stands", async () => {
    const store = createMemoryAiBudgetStore();
    const key = "ai-budget-hold:c:2026-09-11:chat:conv:cmd";

    const first = await store.claimHold(
      key,
      "100000:100000",
      AI_BUDGET_TTL_SEC,
    );
    const second = await store.claimHold(
      key,
      "999999:999999",
      AI_BUDGET_TTL_SEC,
    );

    expect(first).toEqual({ created: true, value: "100000:100000" });
    // Not the value this caller offered: what the owner recorded.
    expect(second).toEqual({ created: false, value: "100000:100000" });
  });

  it("lets exactly one of many overlapping claims create the hold", async () => {
    const store = createMemoryAiBudgetStore();
    const key = "ai-budget-hold:c:2026-09-11:chat:conv:overlap";

    const claims = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        store.claimHold(key, `${String(index)}:0`, AI_BUDGET_TTL_SEC),
      ),
    );

    const created = claims.filter((claim) => claim.created);
    expect(created).toHaveLength(1);
    // And every loser is told the winner's value, not its own.
    for (const claim of claims) {
      expect(claim.value).toBe(created[0]?.value);
    }
  });

  /** Only the caller that deleted it may move the counters. */
  it("drops a hold for exactly one caller", async () => {
    const store = createMemoryAiBudgetStore();
    const key = "ai-budget-hold:c:2026-09-11:chat:conv:drop";
    await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);

    expect(await store.dropHold(key)).toBe(true);
    expect(await store.dropHold(key)).toBe(false);

    await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => store.dropHold(key)),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(1);
  });

  it("forgets a hold once its ttl passes, so a new day reserves again", async () => {
    let nowMs = 1_000_000;
    const store = createMemoryAiBudgetStore({ now: () => nowMs });
    const key = "ai-budget-hold:c:2026-09-11:chat:conv:ttl";

    await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);
    nowMs += AI_BUDGET_TTL_SEC * 1000 + 1;

    expect(await store.dropHold(key)).toBe(false);
    expect(
      (await store.claimHold(key, "200000:0", AI_BUDGET_TTL_SEC)).created,
    ).toBe(true);
  });
});

describe("aiBudgetHoldKey", () => {
  it("names one turn, in one casing, per company and Kyiv day", () => {
    const base = {
      companyId: "ABCDEF00-0000-4000-8000-00000000C001",
      kyivDate: "2026-09-11",
      kind: "chat",
      conversationId: "11111111-1111-4111-8111-111111111111",
      commandId: "22222222-2222-4222-8222-222222222222",
    };
    expect(aiBudgetHoldKey(base)).toBe(
      "ai-budget-hold:abcdef00-0000-4000-8000-00000000c001:2026-09-11:chat:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    );
    // A retry spelling its ids differently must reach the same reservation.
    expect(
      aiBudgetHoldKey({
        ...base,
        conversationId: base.conversationId.toUpperCase(),
        commandId: base.commandId.toUpperCase(),
      }),
    ).toBe(aiBudgetHoldKey(base));
    // An answer and a send under one command token are two turns.
    expect(aiBudgetHoldKey({ ...base, kind: "answer" })).not.toBe(
      aiBudgetHoldKey(base),
    );
    // And a turn is charged on the day it was admitted.
    expect(aiBudgetHoldKey({ ...base, kyivDate: "2026-09-12" })).not.toBe(
      aiBudgetHoldKey(base),
    );
  });
});

describe("aiCompanyBudgetKey", () => {
  it("lowercases companyId so mixed-case UUIDs share one Redis key", () => {
    const kyivDate = "2026-09-02";
    const lower = "abcdef00-0000-4000-8000-00000000c001";
    const mixed = "ABCDef00-0000-4000-8000-00000000c001";
    const upper = "ABCDEF00-0000-4000-8000-00000000C001";
    expect(aiCompanyBudgetKey(mixed, kyivDate)).toBe(
      `ai-budget:${lower}:${kyivDate}`,
    );
    expect(aiCompanyBudgetKey(upper, kyivDate)).toBe(
      aiCompanyBudgetKey(lower, kyivDate),
    );
  });
});
