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
import { describeAiBudgetHoldContract } from "./budget-hold-contract.test-suite.js";

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

/**
 * The same contract `budget.test.ts` runs on the reference store, from the same
 * body (SHO-572). It matters more here: the memory store is serialized by a
 * per-key lock inside one process, while these have to hold across every API
 * and worker process at once, which is what the Lua is for.
 */
describeAiBudgetHoldContract({
  name: "Redis store",
  createStore: () => createRedisAiBudgetStore(redis),
  newKey: holdKey,
  concurrency: 8,
  afterClaim: async (key) => {
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(47 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(48 * 60 * 60);
  },
  afterDrop: async (key) => {
    expect(await redis.exists(key)).toBe(0);
  },
});
