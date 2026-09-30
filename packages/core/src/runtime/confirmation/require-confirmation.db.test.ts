import { randomUUID } from "node:crypto";

import { companies, companyMembers, rolePermissionDefaults } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConfirmationRequiredError,
  CoreInvariantError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineRequestMeta,
  RateLimitHook,
} from "../pipeline/types.js";
import type { ConfirmationSummaryEnv } from "../types.js";
import { createConfirmationHook } from "./create-confirmation-hook.js";
import {
  createInMemoryConfirmationStore,
  type ConfirmationStore,
} from "./store.js";

let database: TestDatabase;

const annaId = "user_anna_require_confirm_db";
const companyA = randomUUID();
const companyB = randomUUID();
const silentLogger = pino({ enabled: false });

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db
    .insert(user)
    .values([
      { id: annaId, name: "Anna", email: "anna-require-confirm@example.test" },
    ]);
  await database.runtime.db.insert(companies).values([
    { id: companyA, name: "Preview A", slug: "preview-a", prefix: "PA" },
    { id: companyB, name: "Preview B", slug: "preview-b", prefix: "PB" },
  ]);
  await database.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "owner", permission: "previewFixture:manage" }]);
  await database.runtime.db.insert(companyMembers).values(
    [companyA, companyB].map((companyId) => ({
      companyId,
      userId: annaId,
      role: "owner" as const,
      permissions: { granted: [], denied: [] },
    })),
  );
});

afterAll(async () => {
  await database.close();
});

const writeContract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  name: "previewFixture.renameThing",
  description: "Idempotent write with no contract-declared confirmation.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["previewFixture:manage"],
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

const draftContract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  name: "previewFixture.draftThing",
  description: "Draft fixture — a card in front of a draft asks twice.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["previewFixture:manage"],
  risk: "draft",
  requiresConfirmation: false,
  idempotent: true,
  audit: false,
  timeout: 5_000,
});

const declaredContract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  name: "previewFixture.deleteThing",
  description: "One of the five contracts that declare confirmation.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["previewFixture:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

type FixtureAction = ImplementedAction<
  typeof writeContract.input,
  typeof writeContract.output
>;

function previewAction(): {
  action: FixtureAction;
  runs: () => number;
  previewCalls: () => number;
} {
  let runs = 0;
  let previewCalls = 0;
  const action = implementAction(writeContract, {
    handler: () => {
      runs += 1;
      return Promise.resolve({ resultId: randomUUID() });
    },
    preview: (input: { note: string }, env: ConfirmationSummaryEnv) => {
      previewCalls += 1;
      return {
        title: `Rename to ${input.note}`,
        lines: [
          { label: "Company", value: env.companyId ?? "none" },
          { label: "Note", value: input.note },
        ],
        notes: ["Price list is missing a currency."],
      };
    },
    auditTarget: () => ({ type: "thing", id: "fixture" }),
  });
  return { action, runs: () => runs, previewCalls: () => previewCalls };
}

function deps(store: ConfirmationStore): ActionPipelineDeps {
  const rateLimit: RateLimitHook = { enforce: () => Promise.resolve() };
  return {
    db: database.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit,
      audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
      idempotency: createIdempotencyHook({ db: database.runtime.db }),
      confirmation: createConfirmationHook({ store }),
    },
  };
}

interface RunOptions {
  readonly key?: string;
  readonly note?: string;
  readonly challengeId?: string;
  readonly companyId?: string;
  readonly requireConfirmation?: true;
}

function requestMeta(options: RunOptions): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ai",
    idempotencyKey: options.key ?? randomUUID(),
    ...(options.challengeId !== undefined
      ? { confirmationChallengeId: options.challengeId }
      : {}),
    ...(options.requireConfirmation === true
      ? { requireConfirmation: true as const }
      : {}),
  };
}

function session(): {
  run(
    action: FixtureAction,
    options?: RunOptions,
  ): Promise<{ resultId: string }>;
  requireChallenge(
    action: FixtureAction,
    options?: RunOptions,
  ): Promise<ConfirmationRequiredError>;
} {
  const store = createInMemoryConfirmationStore();
  const run = (
    action: FixtureAction,
    options: RunOptions = {},
  ): Promise<{ resultId: string }> =>
    executeAction(deps(store), {
      action,
      input: { note: options.note ?? "Oksana" },
      request: requestMeta(options),
      principal: {
        mode: "staff",
        session: { userId: annaId },
        companySelector: options.companyId ?? companyA,
      },
    });
  return {
    run,
    requireChallenge: async (action, options = {}) => {
      const error = await run(action, options).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ConfirmationRequiredError);
      return error as ConfirmationRequiredError;
    },
  };
}

describe("execution-time requireConfirmation (core.md §7, ADR-0050)", () => {
  it("pauses a write whose contract declares no confirmation", async () => {
    const { action, runs, previewCalls } = previewAction();
    const flow = session();

    const required = await flow.requireChallenge(action, {
      requireConfirmation: true,
    });

    expect(runs()).toBe(0);
    expect(previewCalls()).toBe(1);
    expect(required.challenge.summary).toBe("Rename to Oksana");
    expect(required.challenge.preview).toEqual({
      title: "Rename to Oksana",
      lines: [
        { label: "Company", value: companyA },
        { label: "Note", value: "Oksana" },
      ],
      notes: ["Price list is missing a currency."],
    });
  });

  it("executes the attempt that carries the matching challenge", async () => {
    const { action, runs } = previewAction();
    const flow = session();
    const key = randomUUID();
    const required = await flow.requireChallenge(action, {
      key,
      requireConfirmation: true,
    });

    const result = await flow.run(action, {
      key,
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    expect(result.resultId).toHaveLength(36);
    expect(runs()).toBe(1);
  });

  it("refuses a challenge whose input hash no longer matches", async () => {
    const { action, runs } = previewAction();
    const flow = session();
    const key = randomUUID();
    const required = await flow.requireChallenge(action, {
      key,
      requireConfirmation: true,
    });

    const reissued = await flow.requireChallenge(action, {
      key,
      note: "Mykola",
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    expect(reissued.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
    expect(runs()).toBe(0);
  });

  it("refuses a challenge that was already consumed", async () => {
    const { action, runs } = previewAction();
    const flow = session();
    const key = randomUUID();
    const required = await flow.requireChallenge(action, {
      key,
      requireConfirmation: true,
    });
    await flow.run(action, {
      key,
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    const reissued = await flow.requireChallenge(action, {
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    expect(reissued.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
    expect(runs()).toBe(1);
  });

  it("refuses a challenge presented under another company", async () => {
    const { action, runs } = previewAction();
    const flow = session();
    const key = randomUUID();
    const required = await flow.requireChallenge(action, {
      key,
      requireConfirmation: true,
    });

    const reissued = await flow.requireChallenge(action, {
      key,
      companyId: companyB,
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    expect(reissued.challenge.challengeId).not.toBe(
      required.challenge.challengeId,
    );
    expect(runs()).toBe(0);
  });

  it("leaves the classic UI path unpaused", async () => {
    const { action, runs, previewCalls } = previewAction();
    const flow = session();

    const result = await flow.run(action);

    expect(result.resultId).toHaveLength(36);
    expect(runs()).toBe(1);
    expect(previewCalls()).toBe(0);
  });

  it("refuses the flag on an action that is not a write", async () => {
    const action = implementAction(draftContract, {
      handler: () => Promise.resolve({ resultId: randomUUID() }),
    });
    const flow = session();

    await expect(
      flow.run(action, {
        requireConfirmation: true,
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("leaves a contract-declared confirmation on its string summary", async () => {
    let runs = 0;
    const action = implementAction(declaredContract, {
      handler: () => {
        runs += 1;
        return Promise.resolve({ resultId: randomUUID() });
      },
      confirmationSummary: () => "Delete the thing.",
      auditTarget: () => ({ type: "thing", id: "fixture" }),
    });
    const flow = session();
    const key = randomUUID();

    const required = await flow.requireChallenge(action, {
      key,
      requireConfirmation: true,
    });
    const result = await flow.run(action, {
      key,
      requireConfirmation: true,
      challengeId: required.challenge.challengeId,
    });

    expect(required.challenge.summary).toBe("Delete the thing.");
    expect(required.challenge.preview).toBeUndefined();
    expect(result.resultId).toHaveLength(36);
    expect(runs).toBe(1);
  });
});
