/**
 * fnd-T20 — core.md §7: issue / consume / binding mismatch / expiry /
 * fail-closed, without a database. Replay and crash-resume live in the
 * integration suite (they need `idempotency_keys`).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConfirmationRequiredError,
  CoreInvariantError,
  ValidationError,
} from "../../errors/index.js";
import type {
  ConfirmationHook,
  PipelineHookEnv,
  PipelineHookRequestMeta,
  PreflightAuthorization,
  PrincipalInvocation,
} from "../pipeline/types.js";
import {
  CONFIRMATION_TTL_MS,
  createConfirmationHook,
} from "./create-confirmation-hook.js";
import {
  createInMemoryConfirmationStore,
  type ConfirmationStore,
} from "./store.js";

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

const contract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  name: "confirmFixture.revoke",
  description: "High-risk confirmation fixture.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  permissions: ["confirmFixture:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const companyId = "11111111-1111-4111-8111-111111111111";
const userId = "user_anna_confirm";

function requestMeta(
  overrides: Partial<PipelineHookRequestMeta> = {},
): PipelineHookRequestMeta {
  return {
    action: contract.name,
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    ...overrides,
  };
}

function authorization(): PreflightAuthorization {
  return { actor: { type: "user", id: userId }, companyId };
}

function principal(): PrincipalInvocation {
  return {
    mode: "staff",
    session: { userId },
    companySelector: companyId,
  };
}

function env(
  overrides: {
    readonly request?: Partial<PipelineHookRequestMeta>;
    readonly input?: { note: string };
    readonly principal?: PrincipalInvocation;
    readonly authorization?: PreflightAuthorization;
    readonly summary?: string;
  } = {},
): PipelineHookEnv & {
  readonly authorization: PreflightAuthorization;
  readonly summarize: () => string;
} {
  return {
    contract,
    request: requestMeta({
      idempotencyKey: randomUUID(),
      ...overrides.request,
    }),
    principal: overrides.principal ?? principal(),
    input: overrides.input ?? { note: "hello" },
    authorization: overrides.authorization ?? authorization(),
    summarize: () => overrides.summary ?? "Revoke access for one company.",
  };
}

function hook(store?: ConfirmationStore, now?: () => number): ConfirmationHook {
  return createConfirmationHook({
    store:
      store ??
      createInMemoryConfirmationStore(now === undefined ? {} : { now }),
    ...(now === undefined ? {} : { now }),
  });
}

function keyOf(gateEnv: ReturnType<typeof env>): string {
  const key = gateEnv.request.idempotencyKey;
  if (key === undefined) {
    throw new Error("test env is missing the default idempotency key");
  }
  return key;
}

async function issue(
  confirmation: ConfirmationHook,
  gateEnv = env(),
): Promise<ConfirmationRequiredError> {
  const error = await confirmation.gate(gateEnv).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConfirmationRequiredError);
  return error as ConfirmationRequiredError;
}

describe("confirmation hook — first invocation (core.md §7)", () => {
  it("issues a challenge carrying only the redacted summary", async () => {
    const required = await issue(hook());

    expect(required.challenge.summary).toBe("Revoke access for one company.");
    expect(required.challenge.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(Date.parse(required.challenge.expiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(required.clientMessage).toBe(
      "This action requires explicit confirmation.",
    );
    expect(JSON.stringify(required.challenge)).not.toContain(userId);
    expect(JSON.stringify(required.challenge)).not.toContain("hello");
  });

  it("rejects a missing idempotency key before issuing a challenge", async () => {
    const store = createInMemoryConfirmationStore();
    const sets: string[] = [];
    const recording: ConfirmationStore = {
      async set(key, value, ttlMs) {
        sets.push(key);
        await store.set(key, value, ttlMs);
      },
      getAndDelete: (key) => store.getAndDelete(key),
    };

    const gateEnv = env();
    await expect(
      hook(recording).gate({
        ...gateEnv,
        request: {
          action: gateEnv.request.action,
          requestId: gateEnv.request.requestId,
          correlationId: gateEnv.request.correlationId,
          channel: gateEnv.request.channel,
        },
      }),
    ).rejects.toThrow(ValidationError);
    expect(sets).toEqual([]);
  });
});

describe("confirmation hook — consume and bindings", () => {
  it("consumes a matching challenge and returns the grant", async () => {
    const confirmation = hook();
    const first = env();
    const required = await issue(confirmation, first);

    const grant = await confirmation.gate(
      env({
        request: {
          idempotencyKey: keyOf(first),
          confirmationChallengeId: required.challenge.challengeId,
        },
      }),
    );

    expect(grant.challengeId).toBe(required.challenge.challengeId);
    expect(grant.expiresAt.toISOString()).toBe(required.challenge.expiresAt);
  });

  it("issues a new challenge when the input hash does not match", async () => {
    const confirmation = hook();
    const first = env({ input: { note: "original" } });
    const required = await issue(confirmation, first);

    const retry = await issue(
      confirmation,
      env({
        input: { note: "changed" },
        request: {
          idempotencyKey: keyOf(first),
          confirmationChallengeId: required.challenge.challengeId,
        },
      }),
    );

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("issues a new challenge when the principal does not match", async () => {
    const confirmation = hook();
    const first = env();
    const required = await issue(confirmation, first);

    const retry = await issue(
      confirmation,
      env({
        request: {
          idempotencyKey: keyOf(first),
          confirmationChallengeId: required.challenge.challengeId,
        },
        authorization: {
          actor: { type: "user", id: "user_boris_confirm" },
          companyId,
        },
        principal: {
          mode: "staff",
          session: { userId: "user_boris_confirm" },
          companySelector: companyId,
        },
      }),
    );

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("issues a new challenge when the company does not match", async () => {
    const confirmation = hook();
    const first = env();
    const required = await issue(confirmation, first);
    const otherCompany = "22222222-2222-4222-8222-222222222222";

    const retry = await issue(
      confirmation,
      env({
        request: {
          idempotencyKey: keyOf(first),
          confirmationChallengeId: required.challenge.challengeId,
        },
        authorization: {
          actor: { type: "user", id: userId },
          companyId: otherCompany,
        },
        principal: {
          mode: "staff",
          session: { userId },
          companySelector: otherCompany,
        },
      }),
    );

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("issues a new challenge when the idempotency key does not match", async () => {
    const confirmation = hook();
    const first = env();
    const required = await issue(confirmation, first);

    const retry = await issue(
      confirmation,
      env({
        request: {
          idempotencyKey: randomUUID(),
          confirmationChallengeId: required.challenge.challengeId,
        },
      }),
    );

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("stores a null companyId for account actions", async () => {
    const accountContract = defineActionContract({
      transport: "client",
      aiExposure: "internal",
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: [],
      name: "confirmFixture.deleteAccount",
      description: "Account confirmation fixture.",
      principal: "account",
      input: z.object({ note: z.string() }),
      output: z.object({ ok: z.literal(true) }),
      permissions: [],
      risk: "high",
      requiresConfirmation: true,
      idempotent: true,
      audit: true,
      timeout: 5_000,
    });
    let stored: string | undefined;
    const inner = createInMemoryConfirmationStore();
    const recording: ConfirmationStore = {
      async set(key, value, ttlMs) {
        stored = value;
        await inner.set(key, value, ttlMs);
      },
      getAndDelete: (key) => inner.getAndDelete(key),
    };
    const confirmation = createConfirmationHook({ store: recording });
    const gateEnv = {
      contract: accountContract,
      request: requestMeta({ idempotencyKey: randomUUID() }),
      principal: {
        mode: "account" as const,
        session: { userId },
      },
      input: { note: "hello" },
      authorization: {
        actor: { type: "user" as const, id: userId },
        companyId: null,
      },
      summarize: () => "Delete the account.",
    };

    await issue(confirmation, gateEnv);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored ?? "")).toMatchObject({ companyId: null });
  });
});

describe("confirmation hook — single-use and expiry", () => {
  it("burns a consumed token — a second consume issues a new challenge", async () => {
    const confirmation = hook();
    const first = env();
    const required = await issue(confirmation, first);
    const consumeEnv = env({
      request: {
        idempotencyKey: keyOf(first),
        confirmationChallengeId: required.challenge.challengeId,
      },
    });

    await confirmation.gate(consumeEnv);
    const retry = await issue(confirmation, consumeEnv);

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });

  it("issues a new challenge after the 5-minute expiry", async () => {
    const clock = fakeClock();
    const confirmation = hook(
      createInMemoryConfirmationStore({ now: clock.now }),
      clock.now,
    );
    const first = env();
    const required = await issue(confirmation, first);

    clock.advance(CONFIRMATION_TTL_MS + 1);
    const retry = await issue(
      confirmation,
      env({
        request: {
          idempotencyKey: keyOf(first),
          confirmationChallengeId: required.challenge.challengeId,
        },
      }),
    );

    expect(retry.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
  });
});

describe("confirmation hook — fail closed (core.md §7)", () => {
  const failingStore: ConfirmationStore = {
    set() {
      return Promise.reject(new Error("redis connection refused"));
    },
    getAndDelete() {
      return Promise.reject(new Error("redis connection refused"));
    },
  };

  it("does not return a grant when issue cannot store the challenge", async () => {
    await expect(hook(failingStore).gate(env())).rejects.toThrow(
      CoreInvariantError,
    );
  });

  it("does not return a grant when consume cannot reach the store", async () => {
    await expect(
      hook(failingStore).gate(
        env({ request: { confirmationChallengeId: randomUUID() } }),
      ),
    ).rejects.toThrow(CoreInvariantError);
  });
});
