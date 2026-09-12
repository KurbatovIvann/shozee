/**
 * The hold-record contract, run against both budget stores (SHO-572).
 *
 * `budget.test.ts` runs it on the in-memory reference store and
 * `budget-redis.db.test.ts` on Redis. One body rather than a copy each: what
 * this slice needs is that the two stores **agree**, and two copies of a spec
 * are two places that can drift apart while both stay green.
 *
 * This file is not collected as a test itself — the vitest projects include
 * only files ending in `.test.ts`, which this name does not match.
 */
import { describe, expect, it } from "vitest";

import { AI_BUDGET_TTL_SEC, type AiBudgetStore } from "./budget.js";

export function describeAiBudgetHoldContract(options: {
  /** How the store under test is named in the report. */
  readonly name: string;
  readonly createStore: () => AiBudgetStore;
  /** A key no other test is using. */
  readonly newKey: () => string;
  /** How many overlapping callers to race. */
  readonly concurrency: number;
  /** Store-specific checks once a hold stands under `key`. */
  readonly afterClaim?: (key: string) => Promise<void>;
  /** Store-specific checks once a hold has been dropped from `key`. */
  readonly afterDrop?: (key: string) => Promise<void>;
}): void {
  describe(`hold records (${options.name})`, () => {
    it("records a hold once and tells every later caller what stands", async () => {
      const store = options.createStore();
      const key = options.newKey();

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
      // Not the value this caller offered: what the owner recorded. A retry
      // adopts the first attempt's amounts rather than recomputing them from
      // limits that may have been redeployed since.
      expect(second).toEqual({ created: false, value: "100000:100000" });
      await options.afterClaim?.(key);
    });

    it("lets exactly one of many overlapping claims create the hold", async () => {
      const store = options.createStore();
      const key = options.newKey();

      const claims = await Promise.all(
        Array.from({ length: options.concurrency }, (_unused, index) =>
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

    /**
     * The property the at-most-once release rests on: only the caller that
     * removed the record may subtract, so the request and the turn row's
     * finisher can both try and the counter still moves once.
     */
    it("drops a hold for exactly one caller", async () => {
      const store = options.createStore();
      const key = options.newKey();
      await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);

      expect(await store.dropHold(key)).toBe(true);
      expect(await store.dropHold(key)).toBe(false);
      await options.afterDrop?.(key);

      await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);
      const concurrent = await Promise.all(
        Array.from({ length: options.concurrency }, () => store.dropHold(key)),
      );
      expect(concurrent.filter(Boolean)).toHaveLength(1);
    });
  });
}
