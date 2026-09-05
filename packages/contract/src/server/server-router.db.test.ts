/**
 * Transport integration (contract.md §4, §7): a fixture module runs
 * through the real stack — RPC client → RPCHandler → server router →
 * `executeAction` with the audit/idempotency/rate-limit/confirmation
 * hooks against Testcontainers Postgres — and every §4 error class is
 * asserted as its wire code + HTTP status + typed extras.
 */
import { randomUUID } from "node:crypto";

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCHandler } from "@orpc/server/fetch";
import {
  ActionRegistry,
  createConfirmationHook,
  createInMemoryConfirmationStore,
  createInMemoryRateLimitStore,
  createRateLimitHook,
  effectiveCompanyId,
  implementAction,
  type ActionExecutionCtx,
  type ActionPipelineDeps,
  type ImplementedAction,
  type ResolvedTarget,
  type TargetResolutionEnv,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  ConcurrentRetryError,
  ConflictError,
  NotFoundError,
  TimeoutError,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { fixtureProducts } from "@showzy/db/testing/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ContractRouterFor } from "../client/contract-router.js";
import { buildServerRouter } from "./server-router.js";
import type { TransportInvocationContext } from "./transport-context.js";
import { wireErrorInterceptors } from "./wire-error.js";

// ---------------------------------------------------------------------------
// Fixture module — test-only sample actions until real modules exist.
// ---------------------------------------------------------------------------

const writeDefaults = {
  transport: "client" as const,
  aiExposure: "internal" as const,
  risk: "write" as const,
  requiresConfirmation: false,
  idempotent: true,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  audit: true,
  timeout: 5_000,
};

const readDefaults = {
  ...writeDefaults,
  risk: "read" as const,
  idempotent: false,
  audit: false,
};

const scopeOutput = z.object({ companyId: z.string().nullable() });

type ProductRow = typeof fixtureProducts.$inferSelect;

async function resolvePublishedProduct(
  input: { productId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<ProductRow>> {
  // Test-only resolver: full-scan + filter keeps drizzle-orm out of this
  // package's dependencies; the publication rule matrix is core's suite.
  const rows = await env.tx.select().from(fixtureProducts);
  const product = rows.find((row) => row.id === input.productId);
  if (product === undefined || !product.published) {
    throw new NotFoundError();
  }
  return { companyId: product.companyId, resource: product };
}

function hasName(value: unknown): value is Pick<ProductRow, "name"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

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

function shareEcho(
  _input: { token: string; documentId: string },
  ctx: ActionExecutionCtx,
) {
  if (ctx.principal !== "share") {
    throw new NotFoundError();
  }
  return Promise.resolve({
    companyId: ctx.target.companyId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
  });
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
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
      },
    ),
    limited: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.limited",
        description: "Staff read with a one-token rate-limit override.",
        principal: "staff",
        permissions: ["sample:view"],
        rateLimit: { limit: 1, windowSec: 60, scope: "user" },
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
      },
    ),
    submit: implementAction(
      defineActionContract({
        ...writeDefaults,
        name: "sample.submit",
        description: "Idempotent staff write returning a fresh receipt.",
        principal: "staff",
        permissions: ["sample:manage"],
        input: z.object({ note: z.string().min(3) }),
        output: z.object({ receiptId: z.string() }),
      }),
      {
        handler: () => Promise.resolve({ receiptId: randomUUID() }),
        auditTarget: () => ({ type: "sample-receipt", id: randomUUID() }),
      },
    ),
    raise: implementAction(
      defineActionContract({
        ...writeDefaults,
        name: "sample.raise",
        description: "Throws the named error class (wire-table fixture).",
        principal: "staff",
        permissions: ["sample:manage"],
        input: z.object({
          kind: z.enum(["notFound", "conflict", "retry", "timeout", "raw"]),
        }),
        output: z.object({ ok: z.boolean() }),
      }),
      {
        handler: (input) => {
          switch (input.kind) {
            case "notFound":
              throw new NotFoundError();
            case "conflict":
              throw new ConflictError("Sample is already frobnicated.");
            case "retry":
              throw new ConcurrentRetryError(7);
            case "timeout":
              throw new TimeoutError();
            case "raw":
              // Outside the §11 vocabulary — the pipeline must wrap it and
              // the wire must carry no internal detail.
              throw new Error("secret internal detail");
          }
        },
        auditTarget: () => ({ type: "sample-raise", id: randomUUID() }),
      },
    ),
    dangerous: implementAction(
      defineActionContract({
        ...writeDefaults,
        name: "sample.dangerous",
        description: "High-risk staff write behind the confirmation gate.",
        principal: "staff",
        permissions: ["sample:manage"],
        risk: "high",
        requiresConfirmation: true,
        input: z.object({ thing: z.string() }),
        output: z.object({ nonce: z.string() }),
      }),
      {
        handler: () => Promise.resolve({ nonce: randomUUID() }),
        confirmationSummary: (input) =>
          `Irreversibly frobnicate "${input.thing}".`,
        auditTarget: () => ({ type: "sample-frobnication", id: randomUUID() }),
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
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
      },
    ),
    peek: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.peek",
        description: "Anonymous read of one published product.",
        principal: "public",
        publicScope: "target",
        permissions: [],
        input: z.object({ productId: z.uuid() }),
        output: z.object({ name: z.string() }),
      }),
      {
        resolveTarget: resolvePublishedProduct,
        handler: (_input, ctx) => {
          if (ctx.scope !== "target") {
            throw new NotFoundError();
          }
          const resource = ctx.target.resource;
          if (!hasName(resource)) {
            throw new NotFoundError();
          }
          return Promise.resolve({ name: resource.name });
        },
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
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
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
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
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
        handler: shareEcho,
      },
    ),
    submitShare: implementAction(
      defineActionContract({
        ...writeDefaults,
        name: "sample.submitShare",
        description: "Anonymous share-token write of a dual-signed container.",
        principal: "share",
        permissions: [],
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
        handler: shareEcho,
      },
    ),
    internalJob: implementAction(
      defineActionContract({
        ...readDefaults,
        name: "sample.internalJob",
        description: "Internal system read — never routable.",
        principal: "system",
        transport: "internal",
        systemScope: "tenant",
        permissions: [],
        input: z.object({}),
        output: scopeOutput,
      }),
      {
        handler: (_input, ctx) =>
          Promise.resolve({ companyId: effectiveCompanyId(ctx) }),
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let kit: TestKit;
let pipeline: ActionPipelineDeps;
let actions: ReturnType<typeof createSampleActions>;
let rpcHandler: RPCHandler<TransportInvocationContext>;

const CLIENT_IP = "203.0.113.7";

function clientExposedModules(a: ReturnType<typeof createSampleActions>) {
  return {
    sample: {
      plan: a.plan.contract,
      limited: a.limited.contract,
      submit: a.submit.contract,
      raise: a.raise.contract,
      dangerous: a.dangerous.contract,
      discover: a.discover.contract,
      peek: a.peek.contract,
      whoami: a.whoami.contract,
      mine: a.mine.contract,
      getShared: a.getShared.contract,
      submitShare: a.submitShare.contract,
    },
  };
}

type SampleClient = ContractRouterClient<
  ContractRouterFor<ReturnType<typeof clientExposedModules>>
>;

function register<TInput extends z.ZodType, TOutput extends z.ZodType, TTarget>(
  registry: ActionRegistry,
  action: ImplementedAction<TInput, TOutput, TTarget>,
): void {
  registry.registerContract(action.contract);
  registry.registerImplementation(action);
}

function makeContext(
  overrides: Partial<TransportInvocationContext> = {},
): TransportInvocationContext {
  return {
    requestId: randomUUID(),
    channel: "ui",
    session: { userId: kitIdentities.users.anna },
    companySelector: kitIdentities.companies.a,
    clientIp: CLIENT_IP,
    ...overrides,
  };
}

/** In-memory HTTP loop: RPCLink → RPCHandler with the given context. */
function clientFor(context: TransportInvocationContext): SampleClient {
  const link = new RPCLink({
    url: "http://sample.test/rpc",
    fetch: async (request) => {
      const result = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context,
      });
      return result.matched
        ? result.response
        : new Response(null, { status: 404 });
    },
  });
  return createORPCClient<SampleClient>(link);
}

async function expectWireError(
  promise: Promise<unknown>,
): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    return error as ORPCError<string, unknown>;
  }
  throw new Error("expected the invocation to fail with a wire error");
}

beforeAll(async () => {
  kit = await createTestKit();
  pipeline = {
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
  };
  actions = createSampleActions();

  const registry = new ActionRegistry();
  register(registry, actions.plan);
  register(registry, actions.limited);
  register(registry, actions.submit);
  register(registry, actions.raise);
  register(registry, actions.dangerous);
  register(registry, actions.discover);
  register(registry, actions.peek);
  register(registry, actions.whoami);
  register(registry, actions.mine);
  register(registry, actions.getShared);
  register(registry, actions.submitShare);
  register(registry, actions.internalJob);
  const serverRouter = buildServerRouter(clientExposedModules(actions), {
    registry,
    pipeline,
  });
  rpcHandler = new RPCHandler(serverRouter, {
    clientInterceptors: [...wireErrorInterceptors],
  });
});

afterAll(async () => {
  await kit.db.close();
});

// ---------------------------------------------------------------------------
// Boot pairing (contract.md §7: orphans fail boot)
// ---------------------------------------------------------------------------

describe("boot pairing", () => {
  it("orphan descriptor (no implementation) fails boot", () => {
    const registry = new ActionRegistry();
    registry.registerContract(actions.plan.contract);
    expect(() =>
      buildServerRouter(
        { sample: { plan: actions.plan.contract } },
        { registry, pipeline },
      ),
    ).toThrow(/orphan descriptor/);
  });

  it("orphan implementation (no contract) fails boot", () => {
    const registry = new ActionRegistry();
    registry.registerImplementation(actions.plan);
    expect(() => buildServerRouter({}, { registry, pipeline })).toThrow(
      /orphan implementation/,
    );
  });

  it("a registered client action missing from the exposure record fails boot", () => {
    const registry = new ActionRegistry();
    registry.registerContract(actions.plan.contract);
    registry.registerImplementation(actions.plan);
    expect(() => buildServerRouter({}, { registry, pipeline })).toThrow(
      /missing from the contract exposure record/,
    );
  });

  it("a routed descriptor that is not the registered object fails boot", () => {
    const registry = new ActionRegistry();
    registry.registerContract(actions.plan.contract);
    registry.registerImplementation(actions.plan);
    const redefined = defineActionContract({
      ...readDefaults,
      name: "sample.plan",
      description: "Staff read echoing the verified company scope.",
      principal: "staff",
      permissions: ["sample:view"],
      input: z.object({}),
      output: scopeOutput,
    });
    expect(() =>
      buildServerRouter(
        { sample: { plan: redefined } },
        { registry, pipeline },
      ),
    ).toThrow(/different descriptor object/);
  });
});

// ---------------------------------------------------------------------------
// Routing: internal actions have no endpoint
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("transport: internal / system actions have no routable endpoint", async () => {
    const result = await rpcHandler.handle(
      new Request("http://sample.test/rpc/sample/internalJob", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: makeContext() },
    );
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport meta → principal dispatch
// ---------------------------------------------------------------------------

describe("principal dispatch", () => {
  it("staff: the verified selector becomes the company scope", async () => {
    const client = clientFor(makeContext());
    await expect(client.sample.plan({})).resolves.toEqual({
      companyId: kitIdentities.companies.a,
    });
  });

  it("staff: a selector without membership → PERMISSION_DENIED 403", async () => {
    const client = clientFor(
      makeContext({ companySelector: kitIdentities.companies.b }),
    );
    const error = await expectWireError(client.sample.plan({}));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.status).toBe(403);
  });

  it("staff: a missing selector → PERMISSION_DENIED 403", async () => {
    const client = clientFor(makeContext({ companySelector: null }));
    const error = await expectWireError(client.sample.plan({}));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.status).toBe(403);
  });

  it("public-global: no session required; a present selector grants nothing", async () => {
    const client = clientFor(
      makeContext({
        session: null,
        companySelector: kitIdentities.companies.a,
      }),
    );
    await expect(client.sample.discover({})).resolves.toEqual({
      companyId: null,
    });
  });

  it("public-target: published resolves anonymously; unpublished → NOT_FOUND 404", async () => {
    const client = clientFor(
      makeContext({ session: null, companySelector: null }),
    );
    await expect(
      client.sample.peek({ productId: kitIdentities.products.published }),
    ).resolves.toEqual({ name: "Honey cake" });

    const error = await expectWireError(
      client.sample.peek({ productId: kitIdentities.products.unpublished }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("consumer: session required, selector ignored, null company scope", async () => {
    const withSelector = clientFor(
      makeContext({ companySelector: kitIdentities.companies.a }),
    );
    await expect(withSelector.sample.whoami({})).resolves.toEqual({
      companyId: null,
    });

    // The HTTP 401 gate is apps/api (fnd-T26). Reaching the pipeline
    // without a session is defense in depth: PermissionDeniedError → 403.
    const anonymous = clientFor(makeContext({ session: null }));
    const error = await expectWireError(anonymous.sample.whoami({}));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.status).toBe(403);
  });

  it("account: session required, selector ignored, null company scope", async () => {
    const withSelector = clientFor(
      makeContext({ companySelector: kitIdentities.companies.a }),
    );
    await expect(withSelector.sample.mine({})).resolves.toEqual({
      companyId: null,
    });

    const anonymous = clientFor(makeContext({ session: null }));
    const error = await expectWireError(anonymous.sample.mine({}));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.status).toBe(403);
  });

  it("share: no session required; a present selector grants nothing; actor stays anonymous", async () => {
    const client = clientFor(
      makeContext({
        session: { userId: kitIdentities.users.anna },
        companySelector: kitIdentities.companies.b,
      }),
    );
    await expect(
      client.sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toEqual({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
      actorId: "anonymous",
    });

    const anonymous = clientFor(
      makeContext({ session: null, companySelector: null }),
    );
    await expect(
      anonymous.sample.getShared({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    ).resolves.toEqual({
      companyId: kitIdentities.companies.a,
      actorType: "anonymous",
      actorId: "anonymous",
    });
  });

  it("share: invalid, expired, revoked, or mismatched token → NOT_FOUND 404", async () => {
    const client = clientFor(
      makeContext({ session: null, companySelector: null }),
    );
    const cases = [
      { token: "unknown-token", documentId: SHARE.documentA },
      { token: SHARE.expired, documentId: SHARE.documentA },
      { token: SHARE.revoked, documentId: SHARE.documentA },
      { token: SHARE.tokenA, documentId: SHARE.documentB },
    ];
    for (const input of cases) {
      const error = await expectWireError(client.sample.getShared(input));
      expect(error.code).toBe("NOT_FOUND");
      expect(error.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency meta (core.md §5 over the wire)
// ---------------------------------------------------------------------------

describe("idempotency meta", () => {
  it("a missing key on an idempotent mutation → VALIDATION 400", async () => {
    const client = clientFor(makeContext());
    const error = await expectWireError(
      client.sample.submit({ note: "no key supplied" }),
    );
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(400);
  });

  it("a missing key on a share write → VALIDATION 400", async () => {
    const client = clientFor(
      makeContext({ session: null, companySelector: null }),
    );
    const error = await expectWireError(
      client.sample.submitShare({
        token: SHARE.tokenA,
        documentId: SHARE.documentA,
      }),
    );
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(400);
  });

  it("the same key replays the stored response without re-execution", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const first = await client.sample.submit({ note: "replay me" });
    const second = await client.sample.submit({ note: "replay me" });
    expect(second.receiptId).toBe(first.receiptId);
  });

  it("the same key with a different payload → IDEMPOTENCY_CONFLICT 409", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    await client.sample.submit({ note: "original payload" });
    const error = await expectWireError(
      client.sample.submit({ note: "different payload" }),
    );
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Confirmation meta (core.md §7 over the wire)
// ---------------------------------------------------------------------------

describe("confirmation meta", () => {
  it("challenge → confirm → replay; the challenge meta never enters the request hash", async () => {
    const idempotencyKey = randomUUID();

    const first = clientFor(makeContext({ idempotencyKey }));
    const challengeError = await expectWireError(
      first.sample.dangerous({ thing: "widget" }),
    );
    expect(challengeError.code).toBe("CONFIRMATION_REQUIRED");
    expect(challengeError.status).toBe(409);
    const { challenge } = challengeError.data as {
      challenge: { challengeId: string; summary: string; expiresAt: string };
    };
    expect(challenge.summary).toBe('Irreversibly frobnicate "widget".');
    expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now());

    const second = clientFor(
      makeContext({
        idempotencyKey,
        confirmationChallengeId: challenge.challengeId,
      }),
    );
    const executed = await second.sample.dangerous({ thing: "widget" });

    // Same idempotency key without (or with a bogus) challenge: the replay
    // probe answers before the gate — the stored hash covered only the
    // validated input, so challenge meta cannot change it (core.md §5).
    const bare = clientFor(makeContext({ idempotencyKey }));
    await expect(bare.sample.dangerous({ thing: "widget" })).resolves.toEqual(
      executed,
    );
    const bogus = clientFor(
      makeContext({ idempotencyKey, confirmationChallengeId: randomUUID() }),
    );
    await expect(bogus.sample.dangerous({ thing: "widget" })).resolves.toEqual(
      executed,
    );
  });
});

// ---------------------------------------------------------------------------
// The §4 error table over the wire — one test per class
// ---------------------------------------------------------------------------

describe("contract.md §4 error mapping", () => {
  it("input failing the schema → VALIDATION 400 with Zod issues (oRPC remap path)", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(client.sample.submit({ note: "x" }));
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(400);
    const data = error.data as { issues: { path: unknown[] }[] };
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues[0]?.path).toEqual(["note"]);
  });

  it("NotFoundError → NOT_FOUND 404", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(
      client.sample.raise({ kind: "notFound" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("ConflictError → CONFLICT 409 with the domain client message", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(
      client.sample.raise({ kind: "conflict" }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Sample is already frobnicated.");
  });

  it("ConcurrentRetryError → RETRY_IN_PROGRESS 409 with retryAfterSec", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(client.sample.raise({ kind: "retry" }));
    expect(error.code).toBe("RETRY_IN_PROGRESS");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ retryAfterSec: 7 });
  });

  it("TimeoutError → TIMEOUT 504", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(
      client.sample.raise({ kind: "timeout" }),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(error.status).toBe(504);
  });

  it("a raw throw → INTERNAL 500 with no details on the wire", async () => {
    const client = clientFor(makeContext({ idempotencyKey: randomUUID() }));
    const error = await expectWireError(client.sample.raise({ kind: "raw" }));
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
    expect(error.message).toBe("Internal error.");
    expect(JSON.stringify(error.toJSON())).not.toContain(
      "secret internal detail",
    );
  });

  it("an exhausted bucket → RATE_LIMITED 429 with retryAfterSec", async () => {
    const client = clientFor(makeContext());
    await client.sample.limited({});
    const error = await expectWireError(client.sample.limited({}));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.status).toBe(429);
    const data = error.data as { retryAfterSec: number };
    expect(data.retryAfterSec).toBeGreaterThan(0);
  });
});
