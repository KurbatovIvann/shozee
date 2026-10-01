import { randomUUID } from "node:crypto";

import { companies, companyMembers, rolePermissionDefaults } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import {
  ConfirmationRequiredError,
  CoreInvariantError,
  NotFoundError,
} from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import { implementAction } from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineRequestMeta,
} from "../pipeline/types.js";
import { createConfirmationHook } from "./create-confirmation-hook.js";
import {
  createInMemoryConfirmationStore,
  type ConfirmationStore,
} from "./store.js";

let database: TestDatabase;

const annaId = "user_anna_card_drift_db";
const silentLogger = pino({ enabled: false });
const vanishedPrefix = "ВИЛУЧЕНО";

let seededCompanies = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db
    .insert(user)
    .values([{ id: annaId, name: "Anna", email: "anna-drift@example.test" }]);
  await database.runtime.db
    .insert(rolePermissionDefaults)
    .values([{ role: "owner", permission: "cardDrift:manage" }]);
});

afterAll(async () => {
  await database.close();
});

const renameContract = defineActionContract({
  transport: "internal",
  aiExposure: "internal",
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  name: "cardDrift.renameCompany",
  description: "Confirmed rename whose card shows the current name.",
  principal: "staff",
  input: z.object({ note: z.string() }),
  output: z.object({ name: z.string() }),
  permissions: ["cardDrift:manage"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
  timeout: 5_000,
});

let handlerRuns = 0;

const renameCompany = implementAction(renameContract, {
  preview: async (input, env) => {
    const rows = await env.tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, env.companyId ?? ""));
    const row = rows[0];
    if (row === undefined || row.name.startsWith(vanishedPrefix)) {
      throw new NotFoundError();
    }
    return {
      title: `Rename ${row.name}`,
      lines: [
        { label: "Current name", value: row.name },
        { label: "New name", value: input.note },
      ],
    };
  },
  handler: async (input, ctx) => {
    handlerRuns += 1;
    if (!("update" in ctx.db)) {
      throw new CoreInvariantError("rename expects the writable transaction");
    }
    const rows = await ctx.db
      .update(companies)
      .set({ name: input.note })
      .where(eq(companies.id, ctx.companyId))
      .returning({ name: companies.name });
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    return { name: row.name };
  },
  auditTarget: () => ({ type: "company", id: "card-drift" }),
});

async function seedCompany(name: string): Promise<string> {
  const companyId = randomUUID();
  seededCompanies += 1;
  await database.runtime.db.insert(companies).values([
    {
      id: companyId,
      name,
      slug: `drift-${companyId.slice(0, 8)}`,
      prefix: `D${String(seededCompanies).padStart(2, "0")}`,
    },
  ]);
  await database.runtime.db.insert(companyMembers).values([
    {
      companyId,
      userId: annaId,
      role: "owner" as const,
      permissions: { granted: [], denied: [] },
    },
  ]);
  return companyId;
}

async function renameTo(companyId: string, name: string): Promise<void> {
  await database.runtime.db
    .update(companies)
    .set({ name })
    .where(eq(companies.id, companyId));
}

async function currentName(companyId: string): Promise<string> {
  const rows = await database.runtime.db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId));
  const row = rows[0];
  if (row === undefined) {
    throw new CoreInvariantError("seeded company disappeared");
  }
  return row.name;
}

function deps(store: ConfirmationStore): ActionPipelineDeps {
  return {
    db: database.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit: { enforce: () => Promise.resolve() },
      audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
      idempotency: createIdempotencyHook({ db: database.runtime.db }),
      confirmation: createConfirmationHook({ store }),
    },
  };
}

function requestMeta(options: {
  readonly key: string;
  readonly challengeId?: string;
}): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ai",
    idempotencyKey: options.key,
    ...(options.challengeId === undefined
      ? {}
      : { confirmationChallengeId: options.challengeId }),
  };
}

interface Attempt {
  readonly companyId: string;
  readonly store: ConfirmationStore;
  readonly key: string;
  readonly note: string;
}

function submit(
  attempt: Attempt,
  challengeId?: string,
): Promise<{ name: string }> {
  return executeAction(deps(attempt.store), {
    action: renameCompany,
    input: { note: attempt.note },
    request: requestMeta({
      key: attempt.key,
      ...(challengeId === undefined ? {} : { challengeId }),
    }),
    principal: {
      mode: "staff",
      session: { userId: annaId },
      companySelector: attempt.companyId,
    },
  });
}

async function challengeFor(
  attempt: Attempt,
  challengeId?: string,
): Promise<ConfirmationRequiredError> {
  const error = await submit(attempt, challengeId).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConfirmationRequiredError);
  return error as ConfirmationRequiredError;
}

async function startAttempt(seedName: string): Promise<{
  readonly attempt: Attempt;
  readonly required: ConfirmationRequiredError;
}> {
  const companyId = await seedCompany(seedName);
  const attempt: Attempt = {
    companyId,
    store: createInMemoryConfirmationStore(),
    key: randomUUID(),
    note: "Квіти Анни",
  };
  const required = await challengeFor(attempt);
  return { attempt, required };
}

describe("confirmation card drift (core.md §7, ADR-0050)", () => {
  it("executes once when the card re-runs to the same facts", async () => {
    const runsBefore = handlerRuns;
    const { attempt, required } = await startAttempt("Крамниця");

    const result = await submit(attempt, required.challenge.challengeId);

    expect(result.name).toBe(attempt.note);
    expect(handlerRuns - runsBefore).toBe(1);
    expect(await currentName(attempt.companyId)).toBe(attempt.note);
  });

  it("writes nothing and re-challenges with the new card when a fact changed", async () => {
    const runsBefore = handlerRuns;
    const { attempt, required } = await startAttempt("Крамниця");
    expect(required.challenge.preview?.lines[0]?.value).toBe("Крамниця");

    await renameTo(attempt.companyId, "Крамниця №2");
    const redo = await challengeFor(attempt, required.challenge.challengeId);

    expect(redo.challenge.challengeId).not.toBe(required.challenge.challengeId);
    expect(redo.challenge.preview?.lines[0]?.value).toBe("Крамниця №2");
    expect(handlerRuns - runsBefore).toBe(0);
    expect(await currentName(attempt.companyId)).toBe("Крамниця №2");
  });

  it("executes the re-confirmed challenge of the new card", async () => {
    const { attempt, required } = await startAttempt("Крамниця");
    await renameTo(attempt.companyId, "Крамниця №2");
    const redo = await challengeFor(attempt, required.challenge.challengeId);

    const result = await submit(attempt, redo.challenge.challengeId);

    expect(result.name).toBe(attempt.note);
    expect(await currentName(attempt.companyId)).toBe(attempt.note);
  });

  it("replays a confirmed attempt without re-running the card", async () => {
    const runsBefore = handlerRuns;
    const { attempt, required } = await startAttempt("Крамниця");
    const confirmed = await submit(attempt, required.challenge.challengeId);
    await renameTo(attempt.companyId, "Крамниця №3");

    const replayed = await submit(attempt);

    expect(replayed).toEqual(confirmed);
    expect(handlerRuns - runsBefore).toBe(1);
    expect(await currentName(attempt.companyId)).toBe("Крамниця №3");
  });

  it("refuses as the handler would when the re-run cannot resolve the record", async () => {
    const runsBefore = handlerRuns;
    const { attempt, required } = await startAttempt("Крамниця");
    await renameTo(attempt.companyId, `${vanishedPrefix} Крамниця`);

    await expect(
      submit(attempt, required.challenge.challengeId),
    ).rejects.toThrow(NotFoundError);

    expect(handlerRuns - runsBefore).toBe(0);
    expect(await currentName(attempt.companyId)).toBe(
      `${vanishedPrefix} Крамниця`,
    );
  });
});
