/**
 * Redis adapters must match the in-memory reference stores (core.md §7/§10).
 */
import { randomUUID } from "node:crypto";

import { CoreInvariantError } from "@showzy/core/errors";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hmacBetterAuthConsumeKey } from "./auth-ip-hmac.js";
import {
  createRedisAiBudgetStore,
  createRedisAuthRateLimitStore,
  createRedisChoiceStore,
  createRedisConfirmationStore,
  createRedisOtpSendStore,
  createRedisRateLimitStore,
  createRedisSecondaryStorage,
} from "./redis.js";

function fakeClock(startMs = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
});

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

describe("createRedisSecondaryStorage", () => {
  it("getAndDelete consumes a key exactly once (GETDEL)", async () => {
    const store = createRedisSecondaryStorage(redis);
    await store.set("otp:test", "secret", 60);
    expect(await store.getAndDelete("otp:test")).toBe("secret");
    expect(await store.get("otp:test")).toBeNull();
    expect(await store.getAndDelete("otp:test")).toBeNull();
  });
});

describe("createRedisConfirmationStore", () => {
  it("GETDEL returns the value once while unexpired", async () => {
    const store = createRedisConfirmationStore(redis);
    await store.set("confirm:test", "challenge", 60_000);
    expect(await store.getAndDelete("confirm:test")).toBe("challenge");
    expect(await store.getAndDelete("confirm:test")).toBeNull();
  });

  it("expires via PX and GETDEL returns null after expiry", async () => {
    const store = createRedisConfirmationStore(redis);
    await store.set("confirm:ttl", "challenge", 200);
    const remainingMs = await redis.pttl("confirm:ttl");
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(200);

    // Redis can report PTTL 0 while GET/GETDEL still returns the value.
    // Wait until PTTL === -2 (key gone), not <= 0.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (await redis.pttl("confirm:ttl")) !== -2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await redis.pttl("confirm:ttl")).toBe(-2);
    expect(await store.getAndDelete("confirm:ttl")).toBeNull();
  });
});

describe("createRedisRateLimitStore", () => {
  it("allows exactly `limit` instant requests, then denies with a retry hint", async () => {
    const clock = fakeClock();
    const store = createRedisRateLimitStore(redis, { now: clock.now });
    const request = { key: "rl:a:user:u1", limit: 3, windowSec: 60 };

    for (let i = 0; i < 3; i += 1) {
      expect(await store.consume(request)).toEqual({ allowed: true });
    }
    const denied = await store.consume(request);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSec).toBe(20);
    }
  });

  it("refills continuously: waiting the retry hint grants exactly one more token", async () => {
    const clock = fakeClock();
    const store = createRedisRateLimitStore(redis, { now: clock.now });
    const request = { key: "rl:a:user:u2", limit: 2, windowSec: 60 };

    await store.consume(request);
    await store.consume(request);
    expect((await store.consume(request)).allowed).toBe(false);

    clock.advance(30_000);
    expect(await store.consume(request)).toEqual({ allowed: true });
    expect((await store.consume(request)).allowed).toBe(false);
  });
});

describe("createRedisAiBudgetStore", () => {
  it("INCRBYFLOAT adds spend and EXPIRE keeps the key for 48h", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = `ai-budget:test:${randomUUID()}`;
    expect(await store.read(key)).toBe(0);
    expect(await store.add(key, 0.1, 48 * 60 * 60)).toBeCloseTo(0.1);
    expect(await store.add(key, 0.05, 48 * 60 * 60)).toBeCloseTo(0.15);
    expect(await store.read(key)).toBeCloseTo(0.15);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(47 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(48 * 60 * 60);
  });

  it("Lua increment-with-cap allows only one overlapping tryAdd under a one-turn remainder", async () => {
    const store = createRedisAiBudgetStore(redis);
    const key = `ai-budget:test:${randomUUID()}`;
    const [first, second] = await Promise.all([
      store.tryAdd(key, 0.1, 0.1, 48 * 60 * 60),
      store.tryAdd(key, 0.1, 0.1, 48 * 60 * 60),
    ]);
    const allowed = [first, second].filter((decision) => decision.allowed);
    expect(allowed).toHaveLength(1);
    expect(await store.read(key)).toBeCloseTo(0.1);
  });
});

describe("createRedisOtpSendStore", () => {
  it("records at most one send when two attempts race", async () => {
    const store = createRedisOtpSendStore(redis);
    const attempt = {
      key: "otp-send:phone:+380671112233",
      nowMs: 1_000_000,
      cooldownMs: 60_000,
      windowMs: 3_600_000,
      maxSends: 5,
      ttlSeconds: 3600,
    };
    const [first, second] = await Promise.all([
      store.tryRecordSend(attempt),
      store.tryRecordSend(attempt),
    ]);
    const allowed = [first, second].filter((decision) => decision.allowed);
    expect(allowed).toHaveLength(1);
  });
});

describe("createRedisAuthRateLimitStore", () => {
  const ipHmacSecret = "test-ip-hmac-secret";

  it("allows exactly max concurrent consumes, then denies", async () => {
    const store = createRedisAuthRateLimitStore(redis, { ipHmacSecret });
    const rule = { window: 3600, max: 20 };
    const extra = 10;
    const decisions = await Promise.all(
      Array.from({ length: rule.max + extra }, () =>
        store.consume("auth-rl:concurrent", rule),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(
      rule.max,
    );
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(
      extra,
    );
  });

  it("fails closed when Redis eval rejects", async () => {
    const store = createRedisAuthRateLimitStore(
      {
        eval: () => Promise.reject(new Error("ECONNREFUSED")),
      },
      { ipHmacSecret },
    );
    await expect(
      store.consume("auth-rl:down", { window: 3600, max: 20 }),
    ).resolves.toEqual({ allowed: false, retryAfter: 3600 });
  });

  it("stores HMAC digests, not the client IP, as Redis keys", async () => {
    const store = createRedisAuthRateLimitStore(redis, { ipHmacSecret });
    const rule = { window: 3600, max: 20 };
    const v4 = "198.51.100.41|/phone-number/send-otp";
    const v6 = "2001:db8::1|/phone-number/send-otp";
    await store.consume(v4, rule);
    await store.consume(v6, rule);
    const digestV4 = hmacBetterAuthConsumeKey(v4, ipHmacSecret);
    const digestV6 = hmacBetterAuthConsumeKey(v6, ipHmacSecret);
    expect(digestV4).toMatch(/^[0-9a-f]{32}$/);
    expect(digestV6).toMatch(/^[0-9a-f]{32}$/);
    expect(digestV4).not.toContain("198.51.100.41");
    expect(digestV6).not.toContain("2001:db8::1");
    expect(await redis.exists(v4)).toBe(0);
    expect(await redis.exists(v6)).toBe(0);
    expect(await redis.exists(digestV4)).toBe(1);
    expect(await redis.exists(digestV6)).toBe(1);
    expect(await redis.get(digestV4)).not.toContain("198.51.100");
    expect(await redis.get(digestV6)).not.toContain("2001:db8");
  });

  it("keeps two IPs on independent buckets", async () => {
    const store = createRedisAuthRateLimitStore(redis, { ipHmacSecret });
    const rule = { window: 3600, max: 1 };
    const first = "198.51.100.50|/phone-number/send-otp";
    const second = "198.51.100.51|/phone-number/send-otp";
    await expect(store.consume(first, rule)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(store.consume(first, rule)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(store.consume(second, rule)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("refuses construction with an empty HMAC secret", () => {
    expect(() =>
      createRedisAuthRateLimitStore(redis, { ipHmacSecret: "" }),
    ).toThrow(CoreInvariantError);
  });
});

describe("createRedisChoiceStore", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const productId = "44444444-4444-4444-8444-444444444444";
  const variantLemon = "55555555-5555-4555-8555-555555555555";
  const variantVanilla = "66666666-6666-4666-8666-666666666666";
  const customerId = "77777777-7777-4777-8777-777777777777";
  const optionLemon = "88888888-8888-4888-8888-888888888888";
  const optionVanilla = "99999999-9999-4999-8999-999999999999";
  const bind = {
    actorId: "anna",
    companyId,
    conversationId,
  };

  function openRecord(choiceId: string) {
    return {
      status: "open" as const,
      choiceId,
      actorId: "anna",
      companyId,
      conversationId,
      canonicalInput: {
        customer: { by: "id" as const, id: customerId },
        items: [
          {
            product: { by: "id" as const, id: productId },
            variantSelection: { kind: "unspecified" as const },
            quantity: { milli: "1000" },
          },
        ],
      },
      target: { lineIndex: 0, productId, productName: "Macarons" },
      optionMap: {
        [optionLemon]: variantLemon,
        [optionVanilla]: variantVanilla,
      },
      envelope: {
        status: "needs_choice" as const,
        challengeId: choiceId,
        reason: "variant_required" as const,
        productName: "Macarons",
        options: [
          { id: optionLemon, label: "Lemon" },
          { id: optionVanilla, label: "Vanilla" },
        ],
        optionsTruncated: false,
      },
    };
  }

  it("lets exactly one concurrent claim win via Lua", async () => {
    const store = createRedisChoiceStore(redis);
    const choiceId = randomUUID();
    expect(await store.open(openRecord(choiceId))).toBe(true);
    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claim({
          choiceId,
          bind,
          optionId: index % 2 === 0 ? optionLemon : optionVanilla,
        }),
      ),
    );
    const claimed = decisions.filter((decision) => decision.kind === "claimed");
    const replay = decisions.filter((decision) => decision.kind === "replay");
    const conflict = decisions.filter(
      (decision) => decision.kind === "conflict",
    );
    expect(claimed).toHaveLength(1);
    expect(claimed.length + replay.length + conflict.length).toBe(8);
    expect(replay.length + conflict.length).toBe(7);
  });

  it("peeks with GET so a second peek and a later claim still work", async () => {
    const store = createRedisChoiceStore(redis);
    const choiceId = randomUUID();
    await store.open(openRecord(choiceId));
    const first = await store.peek({ choiceId, bind });
    const second = await store.peek({ choiceId, bind });
    expect(first.kind).toBe("found");
    expect(second.kind).toBe("found");
    const claimed = await store.claim({
      choiceId,
      bind,
      optionId: optionLemon,
    });
    expect(claimed.kind).toBe("claimed");
  });

  it("expires without a write", async () => {
    const store = createRedisChoiceStore(redis, { ttlMs: 50 });
    const choiceId = randomUUID();
    await store.open(openRecord(choiceId));
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      (await redis.pttl(`choice:${choiceId}`)) !== -2
    ) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(
      await store.claim({ choiceId, bind, optionId: optionLemon }),
    ).toEqual({ kind: "expired" });
  });
});
