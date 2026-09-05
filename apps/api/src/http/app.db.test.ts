/**
 * HTTP transport integration (contract.md §3/§7, security-operations §8):
 * session gate, principal dispatch, trusted-proxy IP, and OTP over the
 * mounted better-auth handler against Testcontainers Postgres.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/client";
import {
  createContractClient,
  isWireError,
  type ContractRouterFor,
} from "@showzy/contract";
import {
  ActionRegistry,
  createConfirmationHook,
  createInMemoryConfirmationStore,
  createInMemoryRateLimitStore,
  createRateLimitHook,
  effectiveCompanyId,
  implementAction,
  type ImplementedAction,
  type ResolvedTarget,
  type TargetResolutionEnv,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { NotFoundError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { session } from "@showzy/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildAuthOptions } from "../auth/options.js";
import { createAtomicOtpSendStore } from "../auth/otp-send-guard.js";
import { expoClientPolicy, otpPolicy } from "../auth/policy.js";
import {
  createMemoryAuthRateLimitStore,
  createMemorySecondaryStorage,
} from "../stores/memory.js";
import { RedisStoreError } from "../stores/redis.js";
import {
  AUTH_PREFIX,
  createApp,
  REST_PREFIX,
  type AuthInstance,
} from "./app.js";

const PHONE_A = "+380671112233";
const PHONE_B = "+380509998877";
const INGRESS = "10.0.0.1";
const REAL_CLIENT = "203.0.113.50";
const SPOOF = "8.8.8.8";
const PEER_UNTRUSTED = "198.51.100.10";

const readDefaults = {
  transport: "client" as const,
  aiExposure: "internal" as const,
  risk: "read" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  audit: false,
  timeout: 5_000,
};

const scopeOutput = z.object({
  companyId: z.string().nullable(),
  clientIp: z.string(),
});

const SHARE = {
  tokenA: "http-share-token-a",
  tokenB: "http-share-token-b",
  expired: "http-share-token-expired",
  revoked: "http-share-token-revoked",
  documentA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  documentB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const shareInput = z.object({
  token: z.string().min(1),
  documentId: z.uuid(),
});

const shareOutput = z.object({
  companyId: z.string(),
  actorType: z.string(),
  actorId: z.string(),
});

function resolveShareTarget(
  input: { token: string; documentId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<{ documentId: string }>> {
  if (env.principal.mode !== "share") {
    throw new NotFoundError();
  }
  if (input.token === SHARE.expired || input.token === SHARE.revoked) {
    throw new NotFoundError();
  }
  if (input.token === SHARE.tokenA && input.documentId === SHARE.documentA) {
    return Promise.resolve({
      companyId: kitIdentities.companies.a,
      resource: { documentId: SHARE.documentA },
      tokenHash: "hash-a",
    });
  }
  if (input.token === SHARE.tokenB && input.documentId === SHARE.documentB) {
    return Promise.resolve({
      companyId: kitIdentities.companies.b,
      resource: { documentId: SHARE.documentB },
      tokenHash: "hash-b",
    });
  }
  throw new NotFoundError();
}

function createSampleActions() {
  return {
    plan: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.plan",
        description: "Staff read echoing the verified company scope.",
        principal: "staff",
        permissions: ["sample:view"],
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({
            companyId: effectiveCompanyId(ctx),
            clientIp: ctx.clientIp ?? "",
          }),
      },
    ),
    discover: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.discover",
        description: "Anonymous global discovery over the fixture grant.",
        principal: "public",
        publicScope: "globalProjection",
        projectionGrant: "fixture.discovery",
        permissions: [],
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({
            companyId: effectiveCompanyId(ctx),
            clientIp: ctx.clientIp,
          }),
      },
    ),
    whoami: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.whoami",
        description: "Consumer read proving the null company scope.",
        principal: "consumer",
        permissions: [],
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({
            companyId: effectiveCompanyId(ctx),
            clientIp: ctx.clientIp,
          }),
      },
    ),
    mine: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.mine",
        description: "Account read proving the null company scope.",
        principal: "account",
        permissions: [],
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({
            companyId: effectiveCompanyId(ctx),
            clientIp: ctx.clientIp,
          }),
      },
    ),
    getShared: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.getShared",
        description: "Anonymous share-token read of one document.",
        principal: "share",
        permissions: [],
        input: shareInput,
        output: shareOutput,
      }),
      {
        resolveTarget: resolveShareTarget,
        handler: (_input, ctx) => {
          return Promise.resolve({
            companyId: ctx.target.companyId,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
        },
      },
    ),
    submitShare: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.submitShare",
        description: "Anonymous share-token write of a dual-signed container.",
        principal: "share",
        permissions: [],
        risk: "write",
        idempotent: true,
        audit: true,
        input: shareInput,
        output: shareOutput,
      }),
      {
        resolveTarget: resolveShareTarget,
        auditTarget: (env) => {
          const parsed = shareInput.parse(env.input);
          return { type: "document", id: parsed.documentId };
        },
        auditSnapshot: () => ({
          cn: "Test Signer",
          org: "Acme",
          taxId: "1234567890",
          role: "buyer",
        }),
        handler: (_input, ctx) => {
          return Promise.resolve({
            companyId: ctx.target.companyId,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
          });
        },
      },
    ),
  };
}

function createExposed(actions: ReturnType<typeof createSampleActions>) {
  return {
    sample: {
      plan: actions.plan.contract,
      discover: actions.discover.contract,
      whoami: actions.whoami.contract,
      mine: actions.mine.contract,
      getShared: actions.getShared.contract,
      submitShare: actions.submitShare.contract,
    },
  };
}

type SampleRouter = ContractRouterFor<ReturnType<typeof createExposed>>;

function register(
  registry: ActionRegistry,
  action: ImplementedAction<z.ZodType, z.ZodType, unknown>,
): void {
  registry.registerContract(action.contract);
  registry.registerImplementation(action);
}

/** Incremented by the transport `getSession` wrapper — public/share must not bump this. */
let sessionStoreLookups = 0;

function toAuthInstance(auth: {
  handler: AuthInstance["handler"];
  api: {
    getSession: (args: {
      headers: Headers;
    }) => Promise<{ user: { id: string } } | null | undefined>;
  };
}): AuthInstance {
  return {
    handler: (request) => auth.handler(request),
    api: {
      async getSession({ headers }) {
        sessionStoreLookups += 1;
        const result = await auth.api.getSession({ headers });
        if (result === null || result === undefined) {
          return null;
        }
        return { user: { id: result.user.id } };
      },
    },
  };
}

async function insertBearer(kit: TestKit, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await kit.db.runtime.db.insert(session).values({
    id: randomUUID(),
    token,
    userId,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  return token;
}

function tokenFromVerify(response: Response, payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "token" in payload &&
    typeof payload.token === "string" &&
    payload.token !== ""
  ) {
    return payload.token;
  }
  return (
    response.headers.get("set-auth-token") ??
    response.headers.get("set-auth-jwt")
  );
}

let kit: TestKit;
let app: ReturnType<typeof createApp>;
let sentPhone: { phoneNumber: string; code: string }[];
let nowMs: number;

function advanceSeconds(seconds: number): void {
  nowMs += seconds * 1000;
}

beforeAll(async () => {
  kit = await createTestKit();
  sentPhone = [];
  nowMs = Date.parse("2026-08-18T12:00:00Z");
  const secondary = createMemorySecondaryStorage({ now: () => nowMs });
  const auth = betterAuth(
    buildAuthOptions({
      database: drizzleAdapter(kit.db.runtime.db, { provider: "pg" }),
      baseUrl: "http://localhost:3000",
      webOrigins: [],
      secret: "test-only-secret-0123456789abcdef-0000",
      sendPhoneOtp: (data) => {
        sentPhone.push(data);
        return Promise.resolve();
      },
      sendEmailOtp: () => Promise.resolve(),
      otpSendStore: createAtomicOtpSendStore(secondary),
      authRateLimitStore: createMemoryAuthRateLimitStore({
        ipHmacSecret: "test-ip-hmac-secret",
      }),
      secondaryStorage: secondary,
      now: () => nowMs,
    }),
  );
  const actions = createSampleActions();
  const registry = new ActionRegistry();
  register(registry, actions.plan);
  register(registry, actions.discover);
  register(registry, actions.whoami);
  register(registry, actions.mine);
  register(registry, actions.getShared);
  register(registry, actions.submitShare);

  app = createApp({
    auth: toAuthInstance(auth),
    registry,
    contractModules: createExposed(actions),
    pipeline: {
      ...kit.pipeline,
      hooks: {
        ...kit.pipeline.hooks,
        rateLimit: createRateLimitHook({
          store: createInMemoryRateLimitStore(),
          ipHmacSecret: "test-ip-hmac-secret",
          logger: kit.pipeline.logger,
        }),
        confirmation: createConfirmationHook({
          store: createInMemoryConfirmationStore(),
        }),
      },
    },
    trustedProxies: [INGRESS],
    getPeerAddress: (c) => c.req.header("x-test-peer-address") ?? "127.0.0.1",
    pkiProxy: {
      rateLimitStore: createInMemoryRateLimitStore(),
      ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
    },
  });
});

afterAll(async () => {
  await kit.db.close();
});

function rpcClient(options: {
  readonly token?: string | null;
  readonly companyId?: string | null;
  readonly extraHeaders?: Record<string, string>;
}): ReturnType<typeof createContractClient<SampleRouter>>["client"] {
  return createContractClient<SampleRouter>({
    baseUrl: "http://localhost:3000",
    ...(options.token !== undefined && options.token !== null
      ? { getAccessToken: () => options.token }
      : {}),
    ...(options.companyId !== undefined
      ? { initialCompanyId: options.companyId }
      : {}),
    fetch: async (request) => {
      if (options.extraHeaders === undefined) {
        return app.request(request);
      }
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(options.extraHeaders)) {
        headers.set(name, value);
      }
      return app.request(new Request(request, { headers }));
    },
  }).client;
}

async function expectOrpcError(
  promise: Promise<unknown>,
): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    if (error instanceof ORPCError) {
      return error;
    }
  }
  throw new Error("expected the invocation to fail with an oRPC error");
}

async function authPost(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return app.request(`http://localhost:3000${AUTH_PREFIX}${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe("contract.md §7 principal dispatch over HTTP", () => {
  it("no session on a staff action → 401 UNAUTHENTICATED", async () => {
    const error = await expectOrpcError(rpcClient({}).sample.plan({}));
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "UNAUTHENTICATED") {
      expect.unreachable("expected UNAUTHENTICATED");
    }
    expect(error.status).toBe(401);
  });

  it("x-company-id without membership → 403 PERMISSION_DENIED", async () => {
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const error = await expectOrpcError(
      rpcClient({
        token,
        companyId: kitIdentities.companies.b,
      }).sample.plan({}),
    );
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "PERMISSION_DENIED") {
      expect.unreachable("expected PERMISSION_DENIED");
    }
    expect(error.status).toBe(403);
  });

  it("staff with membership succeeds under the verified selector", async () => {
    const token = await insertBearer(kit, kitIdentities.users.anna);
    await expect(
      rpcClient({
        token,
        companyId: kitIdentities.companies.a,
      }).sample.plan({}),
    ).resolves.toMatchObject({ companyId: kitIdentities.companies.a });
  });

  it("public-global without a session succeeds and ignores x-company-id", async () => {
    await expect(
      rpcClient({ companyId: kitIdentities.companies.a }).sample.discover({}),
    ).resolves.toMatchObject({ companyId: null });
  });

  it("consumer with a session succeeds; a present selector grants no company", async () => {
    const token = await insertBearer(kit, kitIdentities.users.anna);
    await expect(
      rpcClient({
        token,
        companyId: kitIdentities.companies.a,
      }).sample.whoami({}),
    ).resolves.toMatchObject({ companyId: null });
  });

  it("account with a session succeeds; a present selector grants no company", async () => {
    const token = await insertBearer(kit, kitIdentities.users.boris);
    await expect(
      rpcClient({
        token,
        companyId: kitIdentities.companies.b,
      }).sample.mine({}),
    ).resolves.toMatchObject({ companyId: null });
  });

  it("consumer without a session → 401", async () => {
    const error = await expectOrpcError(rpcClient({}).sample.whoami({}));
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "UNAUTHENTICATED") {
      expect.unreachable("expected UNAUTHENTICATED");
    }
    expect(error.status).toBe(401);
  });

  it("account without a session → 401", async () => {
    const error = await expectOrpcError(rpcClient({}).sample.mine({}));
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "UNAUTHENTICATED") {
      expect.unreachable("expected UNAUTHENTICATED");
    }
    expect(error.status).toBe(401);
  });

  it("OpenAPI REST alias at /api/v1 serves the same public action", async () => {
    const response = await app.request(
      `http://localhost:3000${REST_PREFIX}/sample/discover`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ companyId: null });
  });

  it("share read without a session does not 401 and uses the token's company", async () => {
    await expect(
      rpcClient({}).sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toEqual({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
      actorId: "anonymous",
    });
  });

  it("share write without a session succeeds when idempotency meta is present", async () => {
    await expect(
      rpcClient({
        extraHeaders: { "idempotency-key": randomUUID() },
      }).sample.submitShare({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toMatchObject({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
    });
  });

  it("share write missing idempotency meta → VALIDATION", async () => {
    const error = await expectOrpcError(
      rpcClient({}).sample.submitShare({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    );
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "VALIDATION") {
      expect.unreachable("expected VALIDATION");
    }
    expect(error.status).toBe(400);
  });

  it("a present session and x-company-id are ignored on share — no user actor, no extra company", async () => {
    const token = await insertBearer(kit, kitIdentities.users.anna);
    const before = sessionStoreLookups;
    await expect(
      rpcClient({
        token,
        companyId: kitIdentities.companies.b,
      }).sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toEqual({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
      actorId: "anonymous",
    });
    expect(sessionStoreLookups).toBe(before);
  });

  it("x-share-token is not consumed — the capability token is action input only", async () => {
    const viaHeader = await expectOrpcError(
      rpcClient({
        extraHeaders: { "x-share-token": SHARE.tokenA },
      }).sample.getShared({
        token: SHARE.tokenB,
        documentId: SHARE.documentA,
      }),
    );
    expect(isWireError(viaHeader)).toBe(true);
    if (!isWireError(viaHeader) || viaHeader.code !== "NOT_FOUND") {
      expect.unreachable("expected NOT_FOUND");
    }
    expect(viaHeader.status).toBe(404);

    await expect(
      rpcClient({}).sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toMatchObject({ companyId: kitIdentities.companies.a });
  });

  it("invalid, expired, revoked, or mismatched share token → 404 NOT_FOUND", async () => {
    const cases = [
      { token: "unknown-token", documentId: SHARE.documentA },
      { token: SHARE.expired, documentId: SHARE.documentA },
      { token: SHARE.revoked, documentId: SHARE.documentA },
      { token: SHARE.tokenA, documentId: SHARE.documentB },
    ];
    for (const input of cases) {
      const error = await expectOrpcError(
        rpcClient({}).sample.getShared(input),
      );
      expect(isWireError(error)).toBe(true);
      if (!isWireError(error) || error.code !== "NOT_FOUND") {
        expect.unreachable("expected NOT_FOUND");
      }
      expect(error.status).toBe(404);
    }
  });

  it("OpenAPI REST alias serves the share read without a session", async () => {
    const response = await app.request(
      `http://localhost:3000${REST_PREFIX}/sample/getShared`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: SHARE.tokenA,
          documentId: SHARE.documentA,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
    });
  });

  it("public and share dispatch do not touch the session store on /rpc or /api/v1", async () => {
    const before = sessionStoreLookups;
    await expect(rpcClient({}).sample.discover({})).resolves.toMatchObject({
      companyId: null,
    });
    await expect(
      rpcClient({}).sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toMatchObject({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
    });
    const publicRest = await app.request(
      `http://localhost:3000${REST_PREFIX}/sample/discover`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(publicRest.status).toBe(200);
    const shareRest = await app.request(
      `http://localhost:3000${REST_PREFIX}/sample/getShared`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: SHARE.tokenA,
          documentId: SHARE.documentA,
        }),
      },
    );
    expect(shareRest.status).toBe(200);
    expect(sessionStoreLookups).toBe(before);
  });

  it("staff dispatch still looks up the session store", async () => {
    const before = sessionStoreLookups;
    const error = await expectOrpcError(rpcClient({}).sample.plan({}));
    expect(isWireError(error)).toBe(true);
    expect(sessionStoreLookups).toBe(before + 1);
  });

  it("no session on a staff REST alias → 401 UNAUTHENTICATED", async () => {
    const response = await app.request(
      `http://localhost:3000${REST_PREFIX}/sample/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        defined: true,
        code: "UNAUTHENTICATED",
        status: 401,
      }),
    );
    if (
      typeof body !== "object" ||
      body === null ||
      !("code" in body) ||
      !("status" in body) ||
      !("message" in body) ||
      typeof body.code !== "string" ||
      typeof body.status !== "number" ||
      typeof body.message !== "string"
    ) {
      expect.unreachable("expected an oRPC error body");
      return;
    }
    const error = new ORPCError(body.code, {
      defined: true,
      status: body.status,
      message: body.message,
    });
    expect(isWireError(error)).toBe(true);
    if (!isWireError(error) || error.code !== "UNAUTHENTICATED") {
      expect.unreachable("expected UNAUTHENTICATED");
    }
  });
});

describe("trusted-proxy IP (security-operations §2)", () => {
  it("ignores a spoofed X-Forwarded-For from an untrusted peer", async () => {
    const result = await rpcClient({
      extraHeaders: {
        "x-test-peer-address": PEER_UNTRUSTED,
        "x-forwarded-for": SPOOF,
      },
    }).sample.discover({});
    expect(result.clientIp).toBe(PEER_UNTRUSTED);
  });

  it("uses X-Forwarded-For when the peer is a trusted ingress", async () => {
    const result = await rpcClient({
      extraHeaders: {
        "x-test-peer-address": INGRESS,
        "x-forwarded-for": REAL_CLIENT,
      },
    }).sample.discover({});
    expect(result.clientIp).toBe(REAL_CLIENT);
  });
});

describe("OTP over HTTP (security-operations §8)", () => {
  it("responds identically for known and unknown phones (non-enumeration)", async () => {
    const first = await authPost("/phone-number/send-otp", {
      phoneNumber: PHONE_A,
    });
    const second = await authPost("/phone-number/send-otp", {
      phoneNumber: PHONE_B,
    });
    expect(first.status).toBe(second.status);
    const firstBody: unknown = await first.json();
    const secondBody: unknown = await second.json();
    expect(firstBody).toEqual(secondBody);
    expect(sentPhone).toHaveLength(2);
    const code = sentPhone[0]?.code ?? "";
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(firstBody)).not.toContain(code);
  });

  it("accepts OTP send from the Expo app origin", async () => {
    const phone = "+380671000010";
    const response = await authPost(
      "/phone-number/send-otp",
      { phoneNumber: phone },
      { origin: expoClientPolicy.origin },
    );
    expect(response.status).toBe(200);
  });

  it("enforces the 60-second resend cooldown over HTTP", async () => {
    const phone = "+380671000001";
    expect(
      (await authPost("/phone-number/send-otp", { phoneNumber: phone })).status,
    ).toBe(200);
    expect(
      (await authPost("/phone-number/send-otp", { phoneNumber: phone })).status,
    ).toBe(429);
    advanceSeconds(otpPolicy.resendCooldownSeconds);
    expect(
      (await authPost("/phone-number/send-otp", { phoneNumber: phone })).status,
    ).toBe(200);
  });

  it("invalidates the code after 5 failed verification attempts", async () => {
    const phone = "+380671000002";
    await authPost("/phone-number/send-otp", { phoneNumber: phone });
    const code = sentPhone.at(-1)?.code ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < otpPolicy.maxVerifyAttempts; i += 1) {
      const failed = await authPost("/phone-number/verify", {
        phoneNumber: phone,
        code: wrong,
      });
      expect(failed.status).toBeGreaterThanOrEqual(400);
    }
    const blocked = await authPost("/phone-number/verify", {
      phoneNumber: phone,
      code: wrong,
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    const dead = await authPost("/phone-number/verify", {
      phoneNumber: phone,
      code,
    });
    expect(dead.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a code after the 5-minute expiry", async () => {
    const phone = "+380671000003";
    // The phone plugin reads Date.now() for OTP expiry rather than the
    // injectable `now` passed to buildAuthOptions (that clock drives the
    // identifier send guard and secondary storage). Patching Date.now is
    // the only way to advance expiry without waiting five minutes.
    const originalNow = Date.now;
    Date.now = () => nowMs;
    try {
      await authPost("/phone-number/send-otp", { phoneNumber: phone });
      const code = sentPhone.at(-1)?.code ?? "";
      advanceSeconds(otpPolicy.expirySeconds + 1);
      const expired = await authPost("/phone-number/verify", {
        phoneNumber: phone,
        code,
      });
      expect(expired.status).toBeGreaterThanOrEqual(400);
    } finally {
      Date.now = originalNow;
    }
  });

  it("a successful verify issues a bearer that can invoke an account action", async () => {
    const phone = "+380671000004";
    await authPost("/phone-number/send-otp", { phoneNumber: phone });
    const code = sentPhone.at(-1)?.code ?? "";
    const verified = await authPost("/phone-number/verify", {
      phoneNumber: phone,
      code,
    });
    expect(verified.status).toBe(200);
    const payload: unknown = await verified.json();
    const bearer = tokenFromVerify(verified, payload);
    expect(bearer).toBeTruthy();
    await expect(
      rpcClient({ token: bearer }).sample.mine({}),
    ).resolves.toMatchObject({ companyId: null });
  });

  it("rate-limits OTP sends to 20 per hour per forwarded IP", async () => {
    const ip = "198.51.100.80";
    const headers = {
      "x-test-peer-address": INGRESS,
      "x-forwarded-for": ip,
    };
    for (let i = 0; i < otpPolicy.maxSendsPerHourPerIp; i += 1) {
      const phone = `+3806720${String(i).padStart(5, "0")}`;
      const response = await authPost(
        "/phone-number/send-otp",
        { phoneNumber: phone },
        headers,
      );
      expect(response.status, `send ${String(i + 1)} from ${ip}`).toBe(200);
    }
    const blocked = await authPost(
      "/phone-number/send-otp",
      { phoneNumber: "+380672099999" },
      headers,
    );
    expect(blocked.status).toBe(429);
  });

  it("blocks a 6th send to the same phone independently of the IP HMAC bucket", async () => {
    const phone = "+380677100001";
    for (let i = 0; i < otpPolicy.maxSendsPerHourPerIdentifier; i += 1) {
      const ip = `198.51.100.${String(110 + i)}`;
      const response = await authPost(
        "/phone-number/send-otp",
        { phoneNumber: phone },
        {
          "x-test-peer-address": INGRESS,
          "x-forwarded-for": ip,
        },
      );
      expect(response.status, `identifier send ${String(i + 1)}`).toBe(200);
      advanceSeconds(otpPolicy.resendCooldownSeconds);
    }
    const blocked = await authPost(
      "/phone-number/send-otp",
      { phoneNumber: phone },
      {
        "x-test-peer-address": INGRESS,
        "x-forwarded-for": "198.51.100.199",
      },
    );
    expect(blocked.status).toBe(429);
  });

  it("caps concurrent OTP sends from one IP at 20 even when phones differ", async () => {
    const ip = "198.51.100.82";
    const headers = {
      "x-test-peer-address": INGRESS,
      "x-forwarded-for": ip,
    };
    const extra = 8;
    const total = otpPolicy.maxSendsPerHourPerIp + extra;
    const sentBefore = sentPhone.length;
    const responses = await Promise.all(
      Array.from({ length: total }, (_, i) => {
        const phone = `+3806740${String(i).padStart(5, "0")}`;
        return authPost(
          "/phone-number/send-otp",
          { phoneNumber: phone },
          headers,
        );
      }),
    );
    const ok = responses.filter((response) => response.status === 200);
    const limited = responses.filter((response) => response.status === 429);
    expect(ok).toHaveLength(otpPolicy.maxSendsPerHourPerIp);
    expect(limited).toHaveLength(extra);
    expect(sentPhone.length - sentBefore).toBe(otpPolicy.maxSendsPerHourPerIp);
  });

  it("fails closed on IP consume errors and never sends SMS", async () => {
    const failSent: { phoneNumber: string; code: string }[] = [];
    const secondary = createMemorySecondaryStorage({ now: () => nowMs });
    const auth = betterAuth(
      buildAuthOptions({
        database: drizzleAdapter(kit.db.runtime.db, { provider: "pg" }),
        baseUrl: "http://localhost:3000",
        webOrigins: [],
        secret: "test-only-secret-0123456789abcdef-0000",
        sendPhoneOtp: (data) => {
          failSent.push(data);
          return Promise.resolve();
        },
        sendEmailOtp: () => Promise.resolve(),
        otpSendStore: createAtomicOtpSendStore(secondary),
        authRateLimitStore: {
          consume: () =>
            Promise.reject(new RedisStoreError("redis unavailable")),
        },
        secondaryStorage: secondary,
        now: () => nowMs,
      }),
    );
    const failApp = createApp({
      auth: toAuthInstance(auth),
      registry: new ActionRegistry(),
      contractModules: {},
      pipeline: kit.pipeline,
      trustedProxies: [INGRESS],
      getPeerAddress: (c) => c.req.header("x-test-peer-address") ?? "127.0.0.1",
      pkiProxy: {
        rateLimitStore: createInMemoryRateLimitStore(),
        ipHmacSecret: "test-pki-proxy-ip-hmac-secret!!",
      },
    });
    const response = await failApp.request(
      `http://localhost:3000${AUTH_PREFIX}/phone-number/send-otp`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "x-test-peer-address": INGRESS,
          "x-forwarded-for": "198.51.100.83",
        },
        body: JSON.stringify({ phoneNumber: "+380675000001" }),
      },
    );
    expect(response.status).toBe(429);
    expect(failSent).toHaveLength(0);
  });

  it("keys the OTP send IP limit on the sanitized forwarded address, not the proxy peer", async () => {
    const otherIp = "198.51.100.81";
    const response = await authPost(
      "/phone-number/send-otp",
      { phoneNumber: "+380672188888" },
      {
        "x-test-peer-address": INGRESS,
        "x-forwarded-for": otherIp,
      },
    );
    expect(response.status).toBe(200);
  });
});
