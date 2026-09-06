/**
 * Integration tests for `ctx.emit` and the outbox flush (fnd-T16 —
 * core.md §6) against the shared Testcontainers harness.
 *
 * Verifies:
 * - The envelope is complete: UUIDv7 event id, name, version, occurredAt,
 *   companyId per scope, aggregate + monotonic sequence, accountable actor,
 *   channel, request/correlation/causation IDs, Zod-validated payload.
 * - Per-aggregate sequences are strictly monotonic — within one handler,
 *   across invocations, and under concurrent emitters.
 * - Emitting an undeclared event, a schema-invalid payload, a malformed
 *   aggregate, or from a read action throws `CoreInvariantError`.
 * - A tenant-scope event without a company scope is rejected and rolls the
 *   whole transaction back.
 * - Outbox rows and sequence increments commit atomically with the handler
 *   transaction: a same-tx failure after the flush removes both.
 * - The buffer seals after the flush — a leaked `ctx.emit` cannot write
 *   outside its transaction.
 */
import { randomUUID } from "node:crypto";

import {
  companies,
  companyMembers,
  domainEvents,
  eventAggregateSequences,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { asc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { ConflictError, CoreInvariantError } from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import type { CtxEmit } from "../context/types.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "../pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  AuditHook,
  PipelineRequestMeta,
  PrincipalInvocation,
  RateLimitHook,
} from "../pipeline/types.js";
import { defineEvent } from "./define-event.js";

let database: TestDatabase;

const anna = "user_anna_emit";
const companyA = randomUUID();
const silentLogger = pino({ enabled: false });

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.runtime.db
    .insert(user)
    .values([{ id: anna, name: "Anna", email: "anna-emit@example.test" }]);
  await database.runtime.db
    .insert(companies)
    .values([{ id: companyA, name: "Emit Co", slug: "emit-co", prefix: "EM" }]);
  // Owner short-circuits permission resolution (owner-all), so the fixture
  // needs no role_permission_defaults rows.
  await database.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: anna,
      role: "owner" as const,
      permissions: { granted: [], denied: [] },
    },
  ]);
});

afterAll(async () => {
  await database.close();
});

// --- Fixtures -----------------------------------------------------------------

const noteCreated = defineEvent({
  name: "emitFixture.noteCreated",
  version: 1,
  scope: "tenant",
  // The default proves the stored payload is the schema *output*.
  payload: z.object({
    noteId: z.uuid(),
    title: z.string().min(1),
    flagged: z.boolean().default(false),
  }),
});

const noteArchived = defineEvent({
  name: "emitFixture.noteArchived",
  version: 2,
  scope: "tenant",
  payload: z.object({ noteId: z.uuid() }),
});

const sweepCompleted = defineEvent({
  name: "emitFixture.sweepCompleted",
  version: 1,
  scope: "global",
  payload: z.object({ scanned: z.number().int() }),
});

const writeContract = defineActionContract({
  name: "emitFixture.createNote",
  description: "Write fixture emitting note events.",
  principal: "staff",
  transport: "internal",
  aiExposure: "internal",
  input: z.object({}),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["emitFixture:write"],
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: ["emitFixture.noteCreated", "emitFixture.noteArchived"],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: true,
  timeout: 5_000,
});

const readContract = defineActionContract({
  name: "emitFixture.listNotes",
  description: "Read fixture that must not be able to emit.",
  principal: "staff",
  transport: "internal",
  aiExposure: "internal",
  input: z.object({}),
  output: z.object({ resultId: z.uuid() }),
  permissions: ["emitFixture:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  // Declared on purpose: the read guard must reject even a declared event.
  emits: ["emitFixture.noteCreated"],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
});

const sweepContract = defineActionContract({
  name: "emitFixture.sweep",
  description:
    "Global system fixture emitting global (and, wrongly declared, tenant) events.",
  principal: "system",
  systemScope: "global",
  transport: "internal",
  aiExposure: "internal",
  input: z.object({}),
  output: z.object({ resultId: z.uuid() }),
  permissions: [],
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  // "emitFixture.noteCreated" is tenant-scoped: the registry-wide contract
  // check would flag this pairing; declaring it here exercises the runtime
  // defense (tenant event without a company scope is rejected at flush).
  emits: ["emitFixture.sweepCompleted", "emitFixture.noteCreated"],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: true,
  timeout: 5_000,
});

function staffAction(
  handler: ImplementedAction<
    typeof writeContract.input,
    typeof writeContract.output
  >["handler"],
): ImplementedAction<typeof writeContract.input, typeof writeContract.output> {
  return implementAction(writeContract, {
    handler,
    auditTarget: () => ({ type: "note", id: "fixture" }),
  });
}

const staffPrincipal: PrincipalInvocation = {
  mode: "staff",
  session: { userId: anna },
  companySelector: companyA,
};

const systemPrincipal: PrincipalInvocation = {
  mode: "system",
  serviceName: "emit-fixture-sweeper",
  scope: { scope: "global" },
};

function requestMeta(
  overrides: Partial<PipelineRequestMeta> = {},
): PipelineRequestMeta {
  return {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    ...overrides,
  };
}

function deps(auditHook?: AuditHook): ActionPipelineDeps {
  const rateLimit: RateLimitHook = { enforce: () => Promise.resolve() };
  return {
    db: database.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit,
      audit:
        auditHook ??
        createAuditHook({ db: database.runtime.db, logger: silentLogger }),
    },
  };
}

async function eventRowsFor(
  aggregateId: string,
): Promise<(typeof domainEvents.$inferSelect)[]> {
  return database.runtime.db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.aggregateId, aggregateId))
    .orderBy(asc(domainEvents.aggregateSequence));
}

async function sequenceRowsFor(
  aggregateId: string,
): Promise<(typeof eventAggregateSequences.$inferSelect)[]> {
  return database.runtime.db
    .select()
    .from(eventAggregateSequences)
    .where(eq(eventAggregateSequences.aggregateId, aggregateId));
}

// --- Tests --------------------------------------------------------------------

describe("ctx.emit — envelope (core.md §6)", () => {
  it("writes a complete envelope into the outbox", async () => {
    const noteId = randomUUID();
    const request = requestMeta();
    const before = Date.now();

    await executeAction(deps(), {
      action: staffAction((_input, ctx) => {
        ctx.emit(noteCreated, {
          aggregate: { type: "note", id: noteId },
          payload: { noteId, title: "Hello" },
        });
        return Promise.resolve({ resultId: randomUUID() });
      }),
      input: {},
      request,
      principal: staffPrincipal,
    });
    const after = Date.now();

    const [row] = await eventRowsFor(noteId);
    expect(row).toBeDefined();
    expect(row?.id).toMatch(UUID_V7_PATTERN);
    expect(row?.name).toBe("emitFixture.noteCreated");
    expect(row?.version).toBe(1);
    expect(row?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row?.occurredAt.getTime()).toBeLessThanOrEqual(after);
    expect(row?.companyId).toBe(companyA);
    expect(row?.aggregateType).toBe("note");
    expect(row?.aggregateId).toBe(noteId);
    expect(row?.aggregateSequence).toBe(1n);
    expect(row?.actorType).toBe("user");
    expect(row?.actorId).toBe(anna);
    expect(row?.channel).toBe("ui");
    expect(row?.requestId).toBe(request.requestId);
    expect(row?.correlationId).toBe(request.correlationId);
    // At the edge, causation defaults to the request itself.
    expect(row?.causationId).toBe(request.requestId);
    // The schema output — the default was applied by payload validation.
    expect(row?.payload).toEqual({ noteId, title: "Hello", flagged: false });
    // Fresh outbox rows are unclaimed and undispatched (fnd-T17's job).
    expect(row?.claimedAt).toBeNull();
    expect(row?.dispatchedAt).toBeNull();
  });

  it("carries a transport-supplied causationId (delivery entrypoint seam)", async () => {
    const noteId = randomUUID();
    const causingEventId = randomUUID();

    await executeAction(deps(), {
      action: staffAction((_input, ctx) => {
        ctx.emit(noteCreated, {
          aggregate: { type: "note", id: noteId },
          payload: { noteId, title: "Caused" },
        });
        return Promise.resolve({ resultId: randomUUID() });
      }),
      input: {},
      request: requestMeta({ causationId: causingEventId }),
      principal: staffPrincipal,
    });

    const [row] = await eventRowsFor(noteId);
    expect(row?.causationId).toBe(causingEventId);
  });

  it("stores a null companyId for global events from a global system action", async () => {
    const sweepId = randomUUID();

    await executeAction(deps(), {
      action: implementAction(sweepContract, {
        handler: (_input, ctx) => {
          ctx.emit(sweepCompleted, {
            aggregate: { type: "sweep", id: sweepId },
            payload: { scanned: 42 },
          });
          return Promise.resolve({ resultId: randomUUID() });
        },
        auditTarget: () => ({ type: "sweep", id: "fixture" }),
      }),
      input: {},
      request: requestMeta({ channel: "system" }),
      principal: systemPrincipal,
    });

    const [row] = await eventRowsFor(sweepId);
    expect(row?.companyId).toBeNull();
    expect(row?.actorType).toBe("system");
    expect(row?.actorId).toBe("emit-fixture-sweeper");
    expect(row?.channel).toBe("system");
  });
});

describe("ctx.emit — per-aggregate ordering (core.md §6)", () => {
  it("assigns strictly monotonic sequences within one handler, in emit order", async () => {
    const noteId = randomUUID();

    await executeAction(deps(), {
      action: staffAction((_input, ctx) => {
        ctx.emit(noteCreated, {
          aggregate: { type: "note", id: noteId },
          payload: { noteId, title: "First" },
        });
        ctx.emit(noteArchived, {
          aggregate: { type: "note", id: noteId },
          payload: { noteId },
        });
        return Promise.resolve({ resultId: randomUUID() });
      }),
      input: {},
      request: requestMeta(),
      principal: staffPrincipal,
    });

    const rows = await eventRowsFor(noteId);
    expect(rows.map((row) => [row.name, row.aggregateSequence])).toEqual([
      ["emitFixture.noteCreated", 1n],
      ["emitFixture.noteArchived", 2n],
    ]);
    // The definition's version rides the envelope, never the name.
    expect(rows[1]?.version).toBe(2);
    const [sequenceRow] = await sequenceRowsFor(noteId);
    expect(sequenceRow?.lastSequence).toBe(2n);
  });

  it("flushes many events for interleaved aggregates in emit order with one sequence row per aggregate", async () => {
    const noteA = randomUUID();
    const noteB = randomUUID();
    const emitted = 5;

    await executeAction(deps(), {
      action: staffAction((_input, ctx) => {
        for (let i = 0; i < emitted; i += 1) {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteA },
            payload: { noteId: noteA, title: `A ${String(i + 1)}` },
          });
          // Interleave a second aggregate so the batched flush has to
          // bucket the buffer, not just count it.
          if (i < 2) {
            ctx.emit(noteCreated, {
              aggregate: { type: "note", id: noteB },
              payload: { noteId: noteB, title: `B ${String(i + 1)}` },
            });
          }
        }
        return Promise.resolve({ resultId: randomUUID() });
      }),
      input: {},
      request: requestMeta(),
      principal: staffPrincipal,
    });

    const rowsA = await eventRowsFor(noteA);
    expect(rowsA.map((row) => row.aggregateSequence)).toEqual([
      1n,
      2n,
      3n,
      4n,
      5n,
    ]);
    expect(rowsA.map((row) => row.payload)).toEqual(
      [1, 2, 3, 4, 5].map((i) => ({
        noteId: noteA,
        title: `A ${String(i)}`,
        flagged: false,
      })),
    );

    const rowsB = await eventRowsFor(noteB);
    expect(rowsB.map((row) => row.aggregateSequence)).toEqual([1n, 2n]);

    const sequenceRowsA = await sequenceRowsFor(noteA);
    expect(sequenceRowsA).toHaveLength(1);
    expect(sequenceRowsA[0]?.lastSequence).toBe(5n);
    const sequenceRowsB = await sequenceRowsFor(noteB);
    expect(sequenceRowsB).toHaveLength(1);
    expect(sequenceRowsB[0]?.lastSequence).toBe(2n);
  });

  it("continues the sequence across invocations", async () => {
    const noteId = randomUUID();
    const emitOnce = staffAction((_input, ctx) => {
      ctx.emit(noteCreated, {
        aggregate: { type: "note", id: noteId },
        payload: { noteId, title: "Again" },
      });
      return Promise.resolve({ resultId: randomUUID() });
    });

    for (let invocation = 0; invocation < 3; invocation += 1) {
      await executeAction(deps(), {
        action: emitOnce,
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      });
    }

    const rows = await eventRowsFor(noteId);
    expect(rows.map((row) => row.aggregateSequence)).toEqual([1n, 2n, 3n]);
  });

  it("keeps sequences monotonic under concurrent emitters", async () => {
    const noteId = randomUUID();
    const participants = 3;
    let releaseAll = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const started: Promise<void>[] = [];

    const runs = Array.from({ length: participants }, () => {
      let signalStarted = (): void => {};
      started.push(
        new Promise<void>((resolve) => {
          signalStarted = resolve;
        }),
      );
      return executeAction(deps(), {
        action: staffAction(async (_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteId },
            payload: { noteId, title: "Concurrent" },
          });
          signalStarted();
          // Hold every handler open until all have buffered, so the
          // step-9 flushes race for the sequence-row lock together.
          await gate;
          return { resultId: randomUUID() };
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      });
    });

    await Promise.all(started);
    releaseAll();
    await Promise.all(runs);

    const rows = await eventRowsFor(noteId);
    expect(rows.map((row) => row.aggregateSequence)).toEqual([1n, 2n, 3n]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(participants);
    const [sequenceRow] = await sequenceRowsFor(noteId);
    expect(sequenceRow?.lastSequence).toBe(3n);
  });
});

describe("ctx.emit — guards", () => {
  it("throws CoreInvariantError on an undeclared event and leaves no rows", async () => {
    const sweepId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: staffAction((_input, ctx) => {
          // Not in writeContract.emits — must throw at the call.
          ctx.emit(sweepCompleted, {
            aggregate: { type: "sweep", id: sweepId },
            payload: { scanned: 1 },
          });
          return Promise.resolve({ resultId: randomUUID() });
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);

    expect(await eventRowsFor(sweepId)).toHaveLength(0);
    expect(await sequenceRowsFor(sweepId)).toHaveLength(0);
  });

  it("throws CoreInvariantError on a payload failing the event schema", async () => {
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: staffAction((_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteId },
            // Compile-valid, schema-invalid: title must be non-empty.
            payload: { noteId, title: "" },
          });
          return Promise.resolve({ resultId: randomUUID() });
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);

    expect(await eventRowsFor(noteId)).toHaveLength(0);
  });

  it("throws CoreInvariantError on a malformed aggregate id", async () => {
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: staffAction((_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: "note-1" },
            payload: { noteId, title: "Bad aggregate" },
          });
          return Promise.resolve({ resultId: randomUUID() });
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);
  });

  it("rejects emits from read actions — even declared ones", async () => {
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: implementAction(readContract, {
          handler: (_input, ctx) => {
            ctx.emit(noteCreated, {
              aggregate: { type: "note", id: noteId },
              payload: { noteId, title: "From a read" },
            });
            return Promise.resolve({ resultId: randomUUID() });
          },
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);

    expect(await eventRowsFor(noteId)).toHaveLength(0);
  });

  it("rejects a tenant-scope event without a company scope and rolls the whole flush back", async () => {
    const sweepId = randomUUID();
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: implementAction(sweepContract, {
          handler: (_input, ctx) => {
            // A valid global event first: its insert must roll back when
            // the second, tenant-scoped emission is rejected at flush.
            ctx.emit(sweepCompleted, {
              aggregate: { type: "sweep", id: sweepId },
              payload: { scanned: 7 },
            });
            ctx.emit(noteCreated, {
              aggregate: { type: "note", id: noteId },
              payload: { noteId, title: "No tenant here" },
            });
            return Promise.resolve({ resultId: randomUUID() });
          },
          auditTarget: () => ({ type: "sweep", id: "fixture" }),
        }),
        input: {},
        request: requestMeta({ channel: "system" }),
        principal: systemPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);

    expect(await eventRowsFor(sweepId)).toHaveLength(0);
    expect(await sequenceRowsFor(sweepId)).toHaveLength(0);
    expect(await eventRowsFor(noteId)).toHaveLength(0);
  });
});

describe("ctx.emit — transactionality (core.md §6)", () => {
  it("emits nothing when the handler fails", async () => {
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: staffAction((_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteId },
            payload: { noteId, title: "Doomed" },
          });
          return Promise.reject(new ConflictError("Handler fails."));
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(ConflictError);

    expect(await eventRowsFor(noteId)).toHaveLength(0);
    expect(await sequenceRowsFor(noteId)).toHaveLength(0);
  });

  it("emits nothing when output validation fails (§4: flush follows step 8)", async () => {
    const noteId = randomUUID();

    await expect(
      executeAction(deps(), {
        action: staffAction((_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteId },
            payload: { noteId, title: "Invalid output" },
          });
          return Promise.resolve({ resultId: "not-a-uuid" });
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(CoreInvariantError);

    expect(await eventRowsFor(noteId)).toHaveLength(0);
  });

  it("rolls back outbox rows and sequence increments with the transaction", async () => {
    const noteId = randomUUID();
    let rowsVisibleInTx = -1;
    // An audit hook that runs after the flush (§4 step 9 order): it first
    // proves the outbox row is visible inside the transaction, then fails —
    // so commit never happens and the rollback must remove row and sequence.
    const failingAudit: AuditHook = {
      recordSuccess: async ({ tx }) => {
        const rows = await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, noteId));
        rowsVisibleInTx = rows.length;
        throw new ConflictError("Audit fails after the flush.");
      },
      recordFailure: () => Promise.resolve(),
    };

    await expect(
      executeAction(deps(failingAudit), {
        action: staffAction((_input, ctx) => {
          ctx.emit(noteCreated, {
            aggregate: { type: "note", id: noteId },
            payload: { noteId, title: "Rolled back" },
          });
          return Promise.resolve({ resultId: randomUUID() });
        }),
        input: {},
        request: requestMeta(),
        principal: staffPrincipal,
      }),
    ).rejects.toThrow(ConflictError);

    // The insert had happened inside the transaction …
    expect(rowsVisibleInTx).toBe(1);
    // … and the rollback removed the outbox row and the sequence increment.
    expect(await eventRowsFor(noteId)).toHaveLength(0);
    expect(await sequenceRowsFor(noteId)).toHaveLength(0);
  });

  it("seals the buffer after the flush — a leaked emit cannot write later", async () => {
    const noteId = randomUUID();
    let leakedEmit: CtxEmit | undefined;

    await executeAction(deps(), {
      action: staffAction((_input, ctx) => {
        leakedEmit = ctx.emit;
        return Promise.resolve({ resultId: randomUUID() });
      }),
      input: {},
      request: requestMeta(),
      principal: staffPrincipal,
    });

    expect(leakedEmit).toBeDefined();
    expect(() =>
      leakedEmit?.(noteCreated, {
        aggregate: { type: "note", id: noteId },
        payload: { noteId, title: "Too late" },
      }),
    ).toThrow(CoreInvariantError);
    expect(await eventRowsFor(noteId)).toHaveLength(0);
  });
});
