/**
 * The Redis budget counters against a real Redis. They must match the memory
 * store (`budget.test.ts`), which is the reference.
 */
import { randomUUID } from "node:crypto";

import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AI_BUDGET_FLOORED_MESSAGE, AI_BUDGET_TTL_SEC } from "./budget.js";
import { createRedisAiBudgetStore } from "./budget-redis.js";

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

function budgetKey(): string {
  return `ai-budget:test:${randomUUID()}`;
}

function holdKey(): string {
  return `ai-budget-hold:test:${randomUUID()}`;
}

describe("createRedisAiBudgetStore", () => {
  it("adds spend and keeps the key for 48h", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = budgetKey();
    expect(await store.read(key)).toBe(0);
    expect(await store.add(key, 0.1, AI_BUDGET_TTL_SEC)).toBeCloseTo(0.1);
    expect(await store.add(key, 0.05, AI_BUDGET_TTL_SEC)).toBeCloseTo(0.15);
    expect(await store.read(key)).toBeCloseTo(0.15);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(47 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(48 * 60 * 60);
  });

  it("allows only one overlapping tryAdd under a one-turn remainder", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = budgetKey();
    const [first, second] = await Promise.all([
      store.tryAdd(key, 0.1, 0.1, AI_BUDGET_TTL_SEC),
      store.tryAdd(key, 0.1, 0.1, AI_BUDGET_TTL_SEC),
    ]);
    const allowed = [first, second].filter((decision) => decision.allowed);
    expect(allowed).toHaveLength(1);
    expect(await store.read(key)).toBeCloseTo(0.1);
  });

  /**
   * A negative counter would lift the day's cap by the amount it is below zero,
   * so a release of more than the counter holds stops at zero (SHO-561).
   */
  it("never leaves a counter below zero", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = budgetKey();
    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);

    expect(await store.add(key, -0.25, AI_BUDGET_TTL_SEC)).toBe(0);
    expect(await store.read(key)).toBe(0);
    expect(await redis.exists(key)).toBe(0);

    // A release against a key that is already gone stops at zero too.
    expect(await store.add(key, -0.1, AI_BUDGET_TTL_SEC)).toBe(0);
    expect(await redis.exists(key)).toBe(0);

    // And the counter counts from zero again, not from below it.
    expect(await store.add(key, 0.1, AI_BUDGET_TTL_SEC)).toBeCloseTo(0.1);
    expect(
      (await store.tryAdd(key, 0.1, 0.15, AI_BUDGET_TTL_SEC)).allowed,
    ).toBe(false);
  });

  it("warns when a release stops a non-zero counter at zero, and only then", async () => {
    const warnings: { fields: Record<string, unknown>; message: string }[] = [];
    const store = createRedisAiBudgetStore(redis, {
      logger: {
        warn(fields, message) {
          warnings.push({ fields, message });
        },
      },
    });
    const key = budgetKey();

    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);
    await store.add(key, -0.05, AI_BUDGET_TTL_SEC);
    await store.add(key, -0.05, AI_BUDGET_TTL_SEC);
    expect(warnings).toEqual([]);

    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);
    expect(await store.add(key, -0.25, AI_BUDGET_TTL_SEC)).toBe(0);
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

  /**
   * The same cases `budget.test.ts` pins on the reference store (SHO-572). They
   * matter more here: the memory store is serialized by a per-key lock in one
   * process, while these have to hold across every API and worker process at
   * once, which is what the Lua is for.
   */
  it("records a hold once and tells every later caller what stands", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = holdKey();

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
    expect(second).toEqual({ created: false, value: "100000:100000" });

    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(47 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(48 * 60 * 60);
  });

  it("lets exactly one of many overlapping claims create the hold", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = holdKey();

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        store.claimHold(key, `${String(index)}:0`, AI_BUDGET_TTL_SEC),
      ),
    );

    const created = claims.filter((claim) => claim.created);
    expect(created).toHaveLength(1);
    for (const claim of claims) {
      expect(claim.value).toBe(created[0]?.value);
    }
  });

  it("drops a hold for exactly one caller", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = holdKey();
    await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);

    expect(await store.dropHold(key)).toBe(true);
    expect(await store.dropHold(key)).toBe(false);
    expect(await redis.exists(key)).toBe(0);

    await store.claimHold(key, "100000:0", AI_BUDGET_TTL_SEC);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => store.dropHold(key)),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(1);
  });

  it("floors concurrent releases at zero", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = budgetKey();
    await store.add(key, 0.1, AI_BUDGET_TTL_SEC);

    await Promise.all(
      Array.from({ length: 5 }, () => store.add(key, -0.1, AI_BUDGET_TTL_SEC)),
    );

    expect(await store.read(key)).toBe(0);
  });
});
