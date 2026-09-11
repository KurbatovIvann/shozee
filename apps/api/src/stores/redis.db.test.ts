/**
 * Redis adapters must match the in-memory reference stores (core.md §7/§10).
 * The budget counters are tested with their store in `@showzy/assistant-runtime`.
 */
import { CoreInvariantError } from "@showzy/core/errors";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hmacBetterAuthConsumeKey } from "./auth-ip-hmac.js";
import {
  createRedisAuthRateLimitStore,
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
