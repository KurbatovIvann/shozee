/**
 * fnd-T14 — core.md §10: per-principal defaults, per-action overrides,
 * rotating IP HMAC (raw IP never a key), and the fail-open/fail-closed
 * split on store failure. Pure unit tests: fake clock, in-memory store.
 */
import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import type { ActionContract } from "../../contract/types.js";
import { CoreInvariantError, RateLimitError } from "../../errors/index.js";
import type {
  PipelineHookEnv,
  PrincipalInvocation,
} from "../pipeline/types.js";
import {
  createRateLimitHook,
  IP_HMAC_ROTATION_MS,
} from "./create-rate-limit-hook.js";
import {
  createInMemoryRateLimitStore,
  type RateLimitConsumeRequest,
  type RateLimitStore,
} from "./token-bucket.js";

function fakeClock(startMs = 1_700_000_000_000): {
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

function captureLogger(): { logger: Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const logger = pino(
    {},
    {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
  );
  return { logger, lines: () => chunks };
}

/** Wraps a store to record every bucket key it was asked to consume. */
function keyRecordingStore(inner: RateLimitStore): {
  store: RateLimitStore;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    store: {
      consume(request: RateLimitConsumeRequest) {
        keys.push(request.key);
        return inner.consume(request);
      },
    },
  };
}

const failingStore: RateLimitStore = {
  consume() {
    return Promise.reject(new Error("redis connection refused"));
  },
};

const contractDefaults = {
  transport: "internal",
  aiExposure: "internal",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
  input: z.object({}),
  output: z.object({}),
} as const;

const staffRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.staffRead",
  description: "Staff read fixture for rate-limit tests.",
  principal: "staff",
  permissions: ["fixture:view"],
  risk: "read",
});

const customerRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.customerRead",
  description: "Customer read fixture for rate-limit tests.",
  principal: "customer",
  transport: "client",
  permissions: [],
  risk: "read",
});

const publicRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.publicRead",
  description: "Public-target read fixture for rate-limit tests.",
  principal: "public",
  transport: "client",
  publicScope: "target",
  permissions: [],
  risk: "read",
});

const consumerRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.consumerRead",
  description: "Consumer read fixture for rate-limit tests.",
  principal: "consumer",
  transport: "client",
  permissions: [],
  risk: "read",
});

const accountRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.accountRead",
  description: "Account read fixture for rate-limit tests.",
  principal: "account",
  transport: "client",
  permissions: [],
  risk: "read",
});

const shareRead = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.shareRead",
  description: "Share read fixture for rate-limit tests.",
  principal: "share",
  transport: "client",
  permissions: [],
  risk: "read",
});

const staffWrite = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.staffWrite",
  description: "Staff write fixture for rate-limit tests.",
  principal: "staff",
  permissions: ["fixture:write"],
  risk: "write",
  idempotent: true,
  audit: true,
});

const systemSync = defineActionContract({
  ...contractDefaults,
  name: "rateLimitFixture.systemSync",
  description: "Global system fixture for rate-limit tests.",
  principal: "system",
  systemScope: "global",
  permissions: [],
  risk: "write",
  audit: true,
});

const staffSession: PrincipalInvocation = {
  mode: "staff",
  session: { userId: "user-anna" },
  companySelector: "company-a",
};

function envFor(
  contract: ActionContract,
  principal: PrincipalInvocation,
  request?: { readonly clientIp?: string },
): PipelineHookEnv {
  return {
    contract,
    principal,
    input: {},
    request: {
      action: contract.name,
      requestId: "req-1",
      correlationId: "req-1",
      channel: "ui",
      ...(request?.clientIp !== undefined
        ? { clientIp: request.clientIp }
        : {}),
    },
  };
}

function hookWith(options?: {
  store?: RateLimitStore;
  now?: () => number;
  secret?: string;
  logger?: Logger;
}): ReturnType<typeof createRateLimitHook> {
  const now = options?.now ?? fakeClock().now;
  return createRateLimitHook({
    store: options?.store ?? createInMemoryRateLimitStore({ now }),
    ipHmacSecret: options?.secret ?? "test-hmac-secret",
    logger: options?.logger ?? captureLogger().logger,
    now,
  });
}

/** Exhausts `count` tokens, expecting every call to pass. */
async function drain(
  hook: ReturnType<typeof createRateLimitHook>,
  env: PipelineHookEnv,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await hook.enforce(env);
  }
}

describe("per-principal defaults (core.md §10)", () => {
  const cases: ReadonlyArray<{
    label: string;
    contract: ActionContract;
    principal: PrincipalInvocation;
    clientIp?: string;
    limit: number;
  }> = [
    {
      label: "staff 120/min",
      contract: staffRead,
      principal: staffSession,
      limit: 120,
    },
    {
      label: "customer 120/min",
      contract: customerRead,
      principal: { mode: "customer", session: { userId: "user-kira" } },
      limit: 120,
    },
    {
      label: "public 30/min per IP HMAC",
      contract: publicRead,
      principal: { mode: "public" },
      clientIp: "203.0.113.9",
      limit: 30,
    },
    {
      label: "consumer 60/min",
      contract: consumerRead,
      principal: { mode: "consumer", session: { userId: "user-olha" } },
      limit: 60,
    },
    {
      label: "account 90/min",
      contract: accountRead,
      principal: { mode: "account", session: { userId: "user-taras" } },
      limit: 90,
    },
    {
      label: "share 30/min per IP HMAC",
      contract: shareRead,
      principal: { mode: "share" },
      clientIp: "203.0.113.11",
      limit: 30,
    },
  ];

  for (const testCase of cases) {
    it(`enforces ${testCase.label}`, async () => {
      const hook = hookWith();
      const env = envFor(testCase.contract, testCase.principal, {
        ...(testCase.clientIp !== undefined
          ? { clientIp: testCase.clientIp }
          : {}),
      });

      await drain(hook, env, testCase.limit);
      const error = await hook.enforce(env).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      if (error instanceof RateLimitError) {
        expect(error.retryAfterSec).toBeGreaterThanOrEqual(1);
      }
    });
  }

  it("keeps system actions unlimited — the store is never consulted", async () => {
    const recording = keyRecordingStore(createInMemoryRateLimitStore());
    const hook = hookWith({ store: recording.store });
    const env = envFor(systemSync, {
      mode: "system",
      serviceName: "np-sync",
      scope: { scope: "global" },
    });

    await drain(hook, env, 500);
    expect(recording.keys).toHaveLength(0);
  });

  it("scopes buckets per user — one exhausted user never throttles another", async () => {
    const clock = fakeClock();
    const hook = hookWith({ now: clock.now });
    const anna = envFor(staffRead, staffSession);
    const boris = envFor(staffRead, {
      mode: "staff",
      session: { userId: "user-boris" },
      companySelector: "company-a",
    });

    await drain(hook, anna, 120);
    await expect(hook.enforce(anna)).rejects.toBeInstanceOf(RateLimitError);
    await expect(hook.enforce(boris)).resolves.toBeUndefined();
  });

  it("scopes buckets per action — different actions have independent budgets", async () => {
    const clock = fakeClock();
    const hook = hookWith({ now: clock.now });
    const otherStaffRead = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.staffReadOther",
      description: "Second staff read fixture for bucket isolation.",
      principal: "staff",
      permissions: ["fixture:view"],
      risk: "read",
    });

    await drain(hook, envFor(staffRead, staffSession), 120);
    await expect(
      hook.enforce(envFor(staffRead, staffSession)),
    ).rejects.toBeInstanceOf(RateLimitError);
    await expect(
      hook.enforce(envFor(otherStaffRead, staffSession)),
    ).resolves.toBeUndefined();
  });

  it("propagates the store's retry hint on the error", async () => {
    const hook = hookWith();
    const env = envFor(publicRead, { mode: "public" }, { clientIp: "1.2.3.4" });

    await drain(hook, env, 30);
    const error = await hook.enforce(env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    if (error instanceof RateLimitError) {
      // One token refills every 60 s / 30 = 2 s with a frozen clock.
      expect(error.retryAfterSec).toBe(2);
    }
  });
});

describe("per-action override", () => {
  it("honors the declared limit over the principal default", async () => {
    const tightStaffRead = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.tightStaffRead",
      description: "Staff read with a tight override.",
      principal: "staff",
      permissions: ["fixture:view"],
      risk: "read",
      rateLimit: { limit: 2, windowSec: 60, scope: "user" },
    });
    const hook = hookWith();
    const env = envFor(tightStaffRead, staffSession);

    await drain(hook, env, 2);
    await expect(hook.enforce(env)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("subjects a system action to its declared override", async () => {
    const limitedSystem = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.limitedSystem",
      description: "System action opting in to a global limit.",
      principal: "system",
      systemScope: "global",
      permissions: [],
      risk: "write",
      audit: true,
      rateLimit: { limit: 1, windowSec: 60, scope: "global" },
    });
    const hook = hookWith();
    const env = envFor(limitedSystem, {
      mode: "system",
      serviceName: "np-sync",
      scope: { scope: "global" },
    });

    await hook.enforce(env);
    await expect(hook.enforce(env)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("shares one bucket across users under scope: global", async () => {
    const globalStaffRead = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.globalStaffRead",
      description: "Staff read with a shared global budget.",
      principal: "staff",
      permissions: ["fixture:view"],
      risk: "read",
      rateLimit: { limit: 1, windowSec: 60, scope: "global" },
    });
    const hook = hookWith();

    await hook.enforce(envFor(globalStaffRead, staffSession));
    await expect(
      hook.enforce(
        envFor(globalStaffRead, {
          mode: "staff",
          session: { userId: "user-boris" },
          companySelector: "company-b",
        }),
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("keys company scope by the trusted system tenant scope", async () => {
    const hook = hookWith();
    const tenantSystem = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.tenantSystem",
      description: "Tenant system action with a per-company budget.",
      principal: "system",
      systemScope: "tenant",
      permissions: [],
      risk: "write",
      audit: true,
      rateLimit: { limit: 1, windowSec: 60, scope: "company" },
    });
    const tenantEnv = (companyId: string): PipelineHookEnv =>
      envFor(tenantSystem, {
        mode: "system",
        serviceName: "np-sync",
        scope: { scope: "tenant", companyId },
      });
    await hook.enforce(tenantEnv("company-a"));
    await expect(hook.enforce(tenantEnv("company-a"))).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await expect(hook.enforce(tenantEnv("company-b"))).resolves.toBeUndefined();
  });

  it("rejects a company-scoped limit on staff — the selector is unverified at this step", async () => {
    // Keying a bucket off the raw `x-company-id` would let a caller mint a
    // fresh bucket per rotated selector value and run unmetered (or drain
    // a victim company's budget). Staff company budgets require
    // post-authorization enforcement, which no action needs yet.
    const companyStaffRead = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.companyStaffRead",
      description: "Staff read misdeclaring a per-company budget.",
      principal: "staff",
      permissions: ["fixture:view"],
      risk: "read",
      rateLimit: { limit: 1, windowSec: 60, scope: "company" },
    });
    const hook = hookWith();

    await expect(
      hook.enforce(envFor(companyStaffRead, staffSession)),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("rejects a company-scoped limit on a mode without a company identifier", async () => {
    const companyConsumerRead = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.companyConsumerRead",
      description: "Consumer read misdeclaring a company-scoped limit.",
      principal: "consumer",
      transport: "client",
      permissions: [],
      risk: "read",
      rateLimit: { limit: 10, windowSec: 60, scope: "company" },
    });
    const hook = hookWith();

    await expect(
      hook.enforce(
        envFor(companyConsumerRead, {
          mode: "consumer",
          session: { userId: "user-olha" },
        }),
      ),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("rejects a user-scoped limit on a public action", async () => {
    const userScopedPublic = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.userScopedPublic",
      description: "Public read misdeclaring a user-scoped limit.",
      principal: "public",
      transport: "client",
      publicScope: "target",
      permissions: [],
      risk: "read",
      rateLimit: { limit: 10, windowSec: 60, scope: "user" },
    });
    const hook = hookWith();

    await expect(
      hook.enforce(
        envFor(userScopedPublic, { mode: "public" }, { clientIp: "1.2.3.4" }),
      ),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });
});

describe("rotating IP HMAC (no raw IP anywhere)", () => {
  const ip = "203.0.113.77";

  it("never puts the raw IP into a bucket key", async () => {
    const recording = keyRecordingStore(createInMemoryRateLimitStore());
    const hook = hookWith({ store: recording.store });

    await hook.enforce(
      envFor(publicRead, { mode: "public" }, { clientIp: ip }),
    );
    expect(recording.keys).toHaveLength(1);
    expect(recording.keys[0]).not.toContain(ip);
    expect(recording.keys[0]).not.toContain("203");
    expect(recording.keys[0]).toMatch(
      new RegExp(
        `^rl:${publicRead.name.replace(".", "\\.")}:ipHmac:[0-9a-f]{32}$`,
      ),
    );
  });

  it("keys one IP consistently within a rotation window", async () => {
    const recording = keyRecordingStore(createInMemoryRateLimitStore());
    const hook = hookWith({ store: recording.store });
    const env = envFor(publicRead, { mode: "public" }, { clientIp: ip });

    await hook.enforce(env);
    await hook.enforce(env);
    expect(recording.keys[0]).toBe(recording.keys[1]);
  });

  it("separates different IPs into different buckets", async () => {
    const recording = keyRecordingStore(createInMemoryRateLimitStore());
    const hook = hookWith({ store: recording.store });

    await hook.enforce(
      envFor(publicRead, { mode: "public" }, { clientIp: "203.0.113.1" }),
    );
    await hook.enforce(
      envFor(publicRead, { mode: "public" }, { clientIp: "203.0.113.2" }),
    );
    expect(recording.keys[0]).not.toBe(recording.keys[1]);
  });

  it("rotates the key when the rotation window advances", async () => {
    const clock = fakeClock();
    const recording = keyRecordingStore(
      createInMemoryRateLimitStore({ now: clock.now }),
    );
    const hook = hookWith({ store: recording.store, now: clock.now });
    const env = envFor(publicRead, { mode: "public" }, { clientIp: ip });

    await hook.enforce(env);
    clock.advance(IP_HMAC_ROTATION_MS);
    await hook.enforce(env);
    expect(recording.keys[0]).not.toBe(recording.keys[1]);
  });

  it("fails closed when a public request arrives without a normalized IP", async () => {
    const hook = hookWith();

    await expect(
      hook.enforce(envFor(publicRead, { mode: "public" })),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("refuses construction with an empty HMAC secret", () => {
    expect(() =>
      createRateLimitHook({
        store: createInMemoryRateLimitStore(),
        ipHmacSecret: "",
        logger: captureLogger().logger,
      }),
    ).toThrow(CoreInvariantError);
  });
});

describe("store failure — fail-open/fail-closed split (core.md §10)", () => {
  it("fails open with an error log for an ordinary authenticated read", async () => {
    const capture = captureLogger();
    const hook = hookWith({ store: failingStore, logger: capture.logger });

    await expect(
      hook.enforce(envFor(staffRead, staffSession)),
    ).resolves.toBeUndefined();
    const errorLine = capture
      .lines()
      .find((line) => line.includes("failing open"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain(staffRead.name);
  });

  it("fails closed for a public read", async () => {
    const hook = hookWith({ store: failingStore });

    await expect(
      hook.enforce(
        envFor(publicRead, { mode: "public" }, { clientIp: "1.2.3.4" }),
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("fails closed for a share read", async () => {
    const hook = hookWith({ store: failingStore });

    await expect(
      hook.enforce(
        envFor(shareRead, { mode: "share" }, { clientIp: "1.2.3.4" }),
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("fails closed for an authenticated mutation", async () => {
    const hook = hookWith({ store: failingStore });

    await expect(
      hook.enforce(envFor(staffWrite, staffSession)),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("fails closed for a high-risk action", async () => {
    const staffHigh = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.staffHigh",
      description: "High-risk staff fixture for fail-closed tests.",
      principal: "staff",
      permissions: ["fixture:manage"],
      risk: "high",
      requiresConfirmation: true,
      idempotent: true,
      audit: true,
    });
    const hook = hookWith({ store: failingStore });

    await expect(
      hook.enforce(envFor(staffHigh, staffSession)),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("fails open for a system action that declared an override", async () => {
    const limitedSystem = defineActionContract({
      ...contractDefaults,
      name: "rateLimitFixture.limitedSystemFailing",
      description: "System override action against a failing store.",
      principal: "system",
      systemScope: "global",
      permissions: [],
      risk: "write",
      audit: true,
      rateLimit: { limit: 1, windowSec: 60, scope: "global" },
    });
    const hook = hookWith({ store: failingStore });

    await expect(
      hook.enforce(
        envFor(limitedSystem, {
          mode: "system",
          serviceName: "np-sync",
          scope: { scope: "global" },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("chains the store failure as the cause on the fail-closed error", async () => {
    const hook = hookWith({ store: failingStore });

    const error = await hook
      .enforce(envFor(staffWrite, staffSession))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    if (error instanceof RateLimitError) {
      expect(error.cause).toBeInstanceOf(Error);
      // The client hint stays conservative: the whole window.
      expect(error.retryAfterSec).toBe(60);
    }
  });
});
