import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  createDbClient,
  domainEvents,
  type ReadTx,
  type Tx,
} from "@showzy/db";
import { fixtureCrmCustomers } from "@showzy/db/testing/fixtures";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { CoreInvariantError, NotFoundError } from "../../errors/index.js";
import { defineJob } from "../../jobs/define-job.js";
import { jobField, jobPayload } from "../../jobs/job-payload.js";
import {
  buildJobEnvelope,
  createCapturingLogger,
  createTestKit,
  type TestKit,
} from "../../testing/kit.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import { createIdempotencyHook } from "../idempotency/create-idempotency-hook.js";
import { kitIdentities } from "../../testing/identities.js";
import {
  jobIsolationCase,
  runJobIsolationCase,
  type SuiteAction,
} from "../../testing/suites.js";
import { defineEvent } from "../events/define-event.js";
import { implementAction } from "../implement-action.js";
import type { ActionPipelineDeps } from "../pipeline/types.js";
import type { JobEnvelope, JobPort } from "./enqueue.js";
import {
  executeJobAction,
  type JobActionInvocation,
} from "./execute-job-action.js";

let kit: TestKit;

const runs = { touch: 0 };

const foreignCustomerId = randomUUID();
const companyA = (): string => kit.identities.companies.a;
const companyB = (): string => kit.identities.companies.b;
const sentinelId = (): string => kit.identities.crmSentinel;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(fixtureCrmCustomers).values({
    id: foreignCustomerId,
    companyId: kit.identities.companies.b,
    userId: null,
    displayName: "Company B customer",
  });
});

afterAll(async () => {
  await kit.db.close();
});

beforeEach(() => {
  kit.jobs.clear();
  runs.touch = 0;
});

const expiring = {
  scope: "tenant",
  discriminator: [],
  lifecycle: "expires",
  retries: 2,
  attemptTimeoutMs: 1_000,
  onExhausted: "jobRun.dropTouch",
} as const;

const touchJob = defineJob({
  ...expiring,
  name: "jobRun.touchCustomer",
  payload: jobPayload({ customerId: jobField.uuid() }),
});
const followUpJob = defineJob({
  ...expiring,
  name: "jobRun.followUp",
  payload: jobPayload({ customerId: jobField.uuid() }),
});
const sweepJob = defineJob({
  name: "jobRun.sweep",
  scope: "global",
  payload: jobPayload({ kind: jobField.literal("daily") }),
  discriminator: [],
  lifecycle: "periodic",
  cron: "*/5 * * * *",
  retries: 0,
  attemptTimeoutMs: 1_000,
});
const globalExpiringJob = defineJob({
  ...expiring,
  scope: "global",
  name: "jobRun.purge",
  payload: jobPayload({ companyHint: jobField.uuid() }),
});

const touched = defineEvent({
  name: "jobRun.touched",
  version: 1,
  scope: "tenant",
  payload: z.object({ customerId: z.uuid() }),
});

const systemWrite = {
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  aiExposure: "internal",
  permissions: [],
  risk: "write",
  requiresConfirmation: false,
  atomicCalls: [],
  atomicCallers: [],
  timeout: 5_000,
} as const;

function requireWritable(capability: ReadTx | Tx): Tx {
  if (!("insert" in capability)) {
    throw new CoreInvariantError("fixture expected the writable capability");
  }
  return capability;
}

const customerInput = z.object({ customerId: z.uuid() });
const auditTarget = () => ({ type: "customer", id: "fixture" });
const touchedOutput = z.object({ touched: z.boolean() });

const touchCustomer = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.touchCustomer",
    description: "Touches one customer of the recorded company.",
    input: customerInput,
    output: z.object({ touched: z.boolean() }),
    idempotent: true,
    audit: true,
    emits: ["jobRun.touched"],
    enqueues: ["jobRun.followUp"],
    errors: ["NOT_FOUND"],
  }),
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      runs.touch += 1;
      const db = requireWritable(ctx.db);
      const updated = await db
        .update(fixtureCrmCustomers)
        .set({ displayName: `touched ${String(runs.touch)}` })
        .where(
          and(
            eq(fixtureCrmCustomers.id, input.customerId),
            eq(fixtureCrmCustomers.companyId, ctx.companyId),
          ),
        )
        .returning({ id: fixtureCrmCustomers.id });
      if (updated.length === 0) {
        throw new NotFoundError();
      }
      ctx.emit(touched, {
        aggregate: { type: "customer", id: input.customerId },
        payload: { customerId: input.customerId },
      });
      ctx.enqueue(followUpJob, { customerId: input.customerId });
      return { touched: true };
    },
    auditTarget,
  },
);

const enqueueThenTouch = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.enqueueThenTouch",
    description:
      "Enqueues a follow-up and refuses a missing customer in its audit step.",
    input: customerInput,
    output: touchedOutput,
    idempotent: true,
    audit: true,
    emits: [],
    enqueues: ["jobRun.followUp"],
    errors: ["NOT_FOUND"],
  }),
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      ctx.enqueue(followUpJob, { customerId: input.customerId });
      const updated = await requireWritable(ctx.db)
        .update(fixtureCrmCustomers)
        .set({ displayName: "touched after enqueue" })
        .where(
          and(
            eq(fixtureCrmCustomers.id, input.customerId),
            eq(fixtureCrmCustomers.companyId, ctx.companyId),
          ),
        )
        .returning({ id: fixtureCrmCustomers.id });
      return { touched: updated.length > 0 };
    },
    auditTarget: ({ output }) => {
      if (touchedOutput.safeParse(output).data?.touched !== true) {
        throw new NotFoundError();
      }
      return auditTarget();
    },
  },
);

const leakyTouch = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.leakyTouch",
    description: "Touches a customer by id alone.",
    input: customerInput,
    output: z.object({ touched: z.boolean() }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  {
    handler: async (input, ctx) => {
      await requireWritable(ctx.db)
        .update(fixtureCrmCustomers)
        .set({ displayName: "leaked" })
        .where(eq(fixtureCrmCustomers.id, input.customerId));
      return { touched: true };
    },
    auditTarget,
  },
);

const renameForCompany = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.renameForCompany",
    description: "Renames every customer of one company.",
    input: z.object({}),
    output: z.object({ changed: z.number() }),
    idempotent: true,
    audit: true,
    emits: [],
    errors: [],
  }),
  {
    handler: async (_input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      const changed = await requireWritable(ctx.db)
        .update(fixtureCrmCustomers)
        .set({ displayName: "swept" })
        .where(eq(fixtureCrmCustomers.companyId, ctx.companyId))
        .returning({ id: fixtureCrmCustomers.id });
      if (changed.length === 0) {
        throw new NotFoundError();
      }
      return { changed: changed.length };
    },
    auditTarget,
  },
);

const leakyRenameForCompany = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.leakyRenameForCompany",
    description: "Renames customers of one company without requiring any.",
    input: z.object({}),
    output: z.object({ changed: z.number() }),
    idempotent: true,
    audit: true,
    emits: [],
    errors: [],
  }),
  {
    handler: async (_input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      const changed = await requireWritable(ctx.db)
        .update(fixtureCrmCustomers)
        .set({ displayName: "swept" })
        .where(eq(fixtureCrmCustomers.companyId, ctx.companyId))
        .returning({ id: fixtureCrmCustomers.id });
      return { changed: changed.length };
    },
    auditTarget,
  },
);

const sweepGlobal = implementAction(
  defineActionContract({
    ...systemWrite,
    systemScope: "global",
    name: "jobRun.sweepGlobal",
    description: "Global sweep fixture.",
    input: z.object({}),
    output: z.object({ scope: z.enum(["tenant", "global"]) }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  {
    handler: (_input, ctx) => Promise.resolve({ scope: ctx.scope }),
    auditTarget,
  },
);

const staffTouch = implementAction(
  defineActionContract({
    principal: "staff",
    transport: "internal",
    aiExposure: "internal",
    permissions: ["jobRun:touch"],
    risk: "write",
    requiresConfirmation: false,
    atomicCalls: [],
    atomicCallers: [],
    timeout: 5_000,
    name: "jobRun.staffTouch",
    description: "Staff fixture.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  { handler: () => Promise.resolve({ ok: true }), auditTarget },
);

const foreignModuleTouch = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "otherModule.touch",
    description: "Another module's system action.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  { handler: () => Promise.resolve({ ok: true }), auditTarget },
);

const systemRead = {
  ...systemWrite,
  risk: "read",
  idempotent: false,
  audit: false,
  emits: [],
} as const;

const readCustomer = implementAction(
  defineActionContract({
    ...systemRead,
    name: "jobRun.readCustomer",
    description: "Reads one customer of the recorded company.",
    input: customerInput,
    output: z.object({ displayName: z.string(), writable: z.boolean() }),
    errors: ["NOT_FOUND"],
  }),
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      const [row] = await ctx.db
        .select({ displayName: fixtureCrmCustomers.displayName })
        .from(fixtureCrmCustomers)
        .where(
          and(
            eq(fixtureCrmCustomers.id, input.customerId),
            eq(fixtureCrmCustomers.companyId, ctx.companyId),
          ),
        );
      if (row === undefined) {
        throw new NotFoundError();
      }
      return { displayName: row.displayName, writable: "insert" in ctx.db };
    },
  },
);

const snapshotReadCustomers = implementAction(
  defineActionContract({
    ...systemRead,
    consistency: "snapshot",
    name: "jobRun.snapshotReadCustomers",
    description: "Reads the recorded company's customers in one snapshot.",
    input: z.object({}),
    output: z.object({
      customers: z.number(),
      isolation: z.string(),
      readOnly: z.string(),
      writable: z.boolean(),
    }),
    errors: [],
  }),
  {
    handler: async (_input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      const rows = await ctx.db
        .select({
          isolation: sql<string>`current_setting('transaction_isolation')`,
          readOnly: sql<string>`current_setting('transaction_read_only')`,
        })
        .from(fixtureCrmCustomers)
        .where(eq(fixtureCrmCustomers.companyId, ctx.companyId));
      const [first] = rows;
      if (first === undefined) {
        throw new NotFoundError();
      }
      return {
        customers: rows.length,
        isolation: first.isolation,
        readOnly: first.readOnly,
        writable: "insert" in ctx.db,
      };
    },
  },
);

const noteRecordedCompany = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.noteRecordedCompany",
    description: "Returns the recorded company without loading a row.",
    input: customerInput,
    output: z.object({ companyId: z.uuid() }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  {
    handler: (_input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("fixture expected a tenant scope");
      }
      return Promise.resolve({ companyId: ctx.companyId });
    },
    auditTarget,
  },
);

const peekNothing = implementAction(
  defineActionContract({
    ...systemRead,
    name: "jobRun.peekNothing",
    description: "Unaudited read that does nothing.",
    input: customerInput,
    output: z.object({ ok: z.boolean() }),
    errors: [],
  }),
  { handler: () => Promise.resolve({ ok: true }) },
);

const nonIdempotentEnqueuer = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "jobRun.enqueueOnce",
    description: "Non-idempotent enqueueing fixture.",
    input: customerInput,
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    audit: true,
    emits: [],
    enqueues: ["jobRun.followUp"],
    errors: [],
  }),
  {
    handler: (input, ctx) => {
      ctx.enqueue(followUpJob, { customerId: input.customerId });
      return Promise.resolve({ ok: true });
    },
    auditTarget,
  },
);

function touchEnvelope(
  options: { companyId?: string; channel?: "ai" | "system" } = {},
) {
  return buildJobEnvelope(touchJob, {
    companyId: options.companyId ?? companyA(),
    payload: { customerId: sentinelId() },
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
  });
}

function sweepEnvelope() {
  return buildJobEnvelope(sweepJob, {
    companyId: null,
    payload: { kind: "daily" },
  });
}

async function insertEmptyCompany(): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companies).values({
    id,
    name: "Empty company",
    slug: `empty-${id}`,
    prefix: "EM",
  });
  return id;
}

async function displayNameOf(customerId: string): Promise<string | undefined> {
  const rows = await kit.db.runtime.db
    .select({ displayName: fixtureCrmCustomers.displayName })
    .from(fixtureCrmCustomers)
    .where(eq(fixtureCrmCustomers.id, customerId));
  return rows[0]?.displayName;
}

function failingAuditDeps(): ActionPipelineDeps {
  return {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      audit: {
        recordSuccess: () =>
          Promise.reject(new CoreInvariantError("injected audit failure")),
        recordFailure: () => Promise.resolve(),
      },
    },
  };
}

describe("executeJobAction runs in the recorded scope (J5)", () => {
  it("runs a tenant action in the recorded company and audits the recorded request id and channel", async () => {
    const envelope = touchEnvelope({ channel: "ai" });

    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope,
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ).resolves.toEqual({ touched: true });

    const audits = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, envelope.requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "jobRun.touchCustomer",
      actorType: "system",
      actorId: "jobRun.touchCustomer",
      channel: "ai",
      correlationId: envelope.correlationId,
      companyId: companyA(),
      outcome: "ok",
    });

    const events = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.causationId, envelope.id));
    expect(events.map((event) => event.name)).toEqual(["jobRun.touched"]);
    expect(kit.jobs.sent.map((sent) => sent.companyId)).toEqual([companyA()]);
  });

  it("derives the same child job ids on a retry and replays after success (J2, J3)", async () => {
    const envelope = touchEnvelope();
    const run = (deps: ActionPipelineDeps) =>
      executeJobAction(deps, {
        job: touchJob,
        envelope,
        action: touchCustomer,
        input: { customerId: sentinelId() },
      });

    const attempted: JobEnvelope[] = [];
    const failing = failingAuditDeps();
    const attemptPort: JobPort = {
      enqueue(_tx, envelopes) {
        attempted.push(...envelopes);
        return Promise.resolve();
      },
    };

    await expect(
      run({ ...failing, hooks: { ...failing.hooks, jobs: attemptPort } }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await run(kit.pipeline);
    expect(attempted).toHaveLength(1);
    expect(kit.jobs.sent).toHaveLength(1);
    expect(kit.jobs.sent[0]?.id).toBe(attempted[0]?.id);

    await run(kit.pipeline);
    expect(runs.touch).toBe(2);
    expect(kit.jobs.sent).toHaveLength(1);
  });

  it("leaves nothing at the port when a direct job run rolls back after the send", async () => {
    await expect(
      executeJobAction(failingAuditDeps(), {
        job: touchJob,
        envelope: touchEnvelope(),
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(runs.touch).toBe(1);
    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("fails closed when the recorded company does not exist", async () => {
    const before = await displayNameOf(sentinelId());

    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: touchEnvelope({ companyId: randomUUID() }),
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(runs.touch).toBe(0);
    expect(await displayNameOf(sentinelId())).toBe(before);
  });

  it("refuses a missing recorded company before an action that needs no row runs", async () => {
    const run = (companyId: string) => {
      const envelope = touchEnvelope({ companyId });
      return executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope,
        action: noteRecordedCompany,
        input: envelope.payload,
      });
    };

    await expect(run(companyA())).resolves.toEqual({ companyId: companyA() });
    await expect(run(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a missing fan-out company before an action that needs no row runs", async () => {
    const fanOut = (fanOutCompanyId: string) =>
      executeJobAction(kit.pipeline, {
        job: sweepJob,
        envelope: sweepEnvelope(),
        action: noteRecordedCompany,
        input: { customerId: sentinelId() },
        fanOutCompanyId,
      });

    await expect(fanOut(companyA())).resolves.toEqual({
      companyId: companyA(),
    });
    await expect(fanOut(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs a global action of a periodic job with no company", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        job: sweepJob,
        envelope: sweepEnvelope(),
        action: sweepGlobal,
        input: {},
      }),
    ).resolves.toEqual({ scope: "global" });
  });

  it("fans a periodic job out to a company whose owned rows it loads in the execution transaction", async () => {
    const foreignBefore = await displayNameOf(foreignCustomerId);

    const result = await executeJobAction(kit.pipeline, {
      job: sweepJob,
      envelope: sweepEnvelope(),
      action: renameForCompany,
      input: {},
      fanOutCompanyId: companyA(),
    });

    expect(result.changed).toBeGreaterThan(0);
    expect(await displayNameOf(sentinelId())).toBe("swept");
    expect(await displayNameOf(foreignCustomerId)).toBe(foreignBefore);
  });

  it.each<[string, () => Promise<string>]>([
    ["an existing company without an owned row", insertEmptyCompany],
    ["a company that does not exist", () => Promise.resolve(randomUUID())],
  ])(
    "fails closed when a periodic job fans out to %s and changes nothing",
    async (_label, companyFor) => {
      const sentinelBefore = await displayNameOf(sentinelId());
      const foreignBefore = await displayNameOf(foreignCustomerId);
      const envelope = sweepEnvelope();

      await expect(
        executeJobAction(kit.pipeline, {
          job: sweepJob,
          envelope,
          action: renameForCompany,
          input: {},
          fanOutCompanyId: await companyFor(),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await displayNameOf(sentinelId())).toBe(sentinelBefore);
      expect(await displayNameOf(foreignCustomerId)).toBe(foreignBefore);
      const audits = await kit.db.runtime.db
        .select({ outcome: auditLog.outcome })
        .from(auditLog)
        .where(eq(auditLog.requestId, envelope.requestId));
      expect(audits.every((row) => row.outcome !== "ok")).toBe(true);
    },
  );

  it("refuses to fan a tenant job out to another company", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: touchEnvelope(),
        action: renameForCompany,
        input: {},
        fanOutCompanyId: companyB(),
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("refuses to fan a global expires job out to a company its payload names", async () => {
    const before = await displayNameOf(foreignCustomerId);

    await expect(
      executeJobAction(kit.pipeline, {
        job: globalExpiringJob,
        envelope: buildJobEnvelope(globalExpiringJob, {
          companyId: null,
          payload: { companyHint: companyB() },
        }),
        action: renameForCompany,
        input: {},
        fanOutCompanyId: companyB(),
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(await displayNameOf(foreignCustomerId)).toBe(before);
  });

  it.each<[string, () => JobActionInvocation<z.ZodType, z.ZodType, unknown>]>([
    [
      "an envelope naming another job",
      () => ({
        job: followUpJob,
        envelope: touchEnvelope(),
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ],
    [
      "a tenant job's envelope without a company",
      () => ({
        job: touchJob,
        envelope: buildJobEnvelope(touchJob, {
          companyId: null,
          payload: { customerId: sentinelId() },
        }),
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ],
    [
      "a tenant job's envelope without a company that asks to fan out",
      () => ({
        job: touchJob,
        envelope: buildJobEnvelope(touchJob, {
          companyId: null,
          payload: { customerId: sentinelId() },
        }),
        action: renameForCompany,
        input: {},
        fanOutCompanyId: companyA(),
      }),
    ],
    [
      "a global job's envelope with a company",
      () => ({
        job: sweepJob,
        envelope: buildJobEnvelope(sweepJob, {
          companyId: companyA(),
          payload: { kind: "daily" },
        }),
        action: renameForCompany,
        input: {},
      }),
    ],
  ])("refuses %s before running anything", async (_label, invocation) => {
    const before = await displayNameOf(sentinelId());

    await expect(
      executeJobAction(kit.pipeline, invocation()),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(runs.touch).toBe(0);
    expect(await displayNameOf(sentinelId())).toBe(before);
    expect(kit.jobs.sent).toHaveLength(0);
  });

  it("holds no connection around the pipeline, so a pool of one connection runs jobs", async () => {
    const single = createDbClient({
      databaseUrl: String(kit.db.runtime.pool.options.connectionString),
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    const { logger } = createCapturingLogger();
    const deps: ActionPipelineDeps = {
      ...kit.pipeline,
      db: kit.jobs.commitBound(single.db),
      hooks: {
        ...kit.pipeline.hooks,
        audit: createAuditHook({ db: single.db, logger }),
        idempotency: createIdempotencyHook({ db: single.db }),
      },
    };
    try {
      await expect(
        executeJobAction(deps, {
          job: touchJob,
          envelope: touchEnvelope(),
          action: touchCustomer,
          input: { customerId: sentinelId() },
        }),
      ).resolves.toEqual({ touched: true });
      await expect(
        executeJobAction(deps, {
          job: touchJob,
          envelope: touchEnvelope({ companyId: randomUUID() }),
          action: touchCustomer,
          input: { customerId: sentinelId() },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await single.pool.end();
    }
  });

  it("runs a system read of a tenant job in the recorded company on a read-only capability", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: touchEnvelope(),
        action: readCustomer,
        input: { customerId: sentinelId() },
      }),
    ).resolves.toEqual({
      displayName: await displayNameOf(sentinelId()),
      writable: false,
    });
  });

  it.each<[string, () => { companyId: string; customerId: string }]>([
    [
      "a payload naming another company's row",
      () => ({ companyId: companyA(), customerId: foreignCustomerId }),
    ],
    [
      "a recorded company that does not exist",
      () => ({ companyId: randomUUID(), customerId: sentinelId() }),
    ],
  ])("fails a system read job action closed on %s", async (_label, target) => {
    const { companyId, customerId } = target();
    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: buildJobEnvelope(touchJob, {
          companyId,
          payload: { customerId },
        }),
        action: readCustomer,
        input: { customerId },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs a snapshot read job action in one read-only repeatable-read transaction", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: touchEnvelope(),
        action: snapshotReadCustomers,
        input: {},
      }),
    ).resolves.toEqual({
      customers: expect.any(Number) as number,
      isolation: "repeatable read",
      readOnly: "on",
      writable: false,
    });
  });

  it.each<[string, SuiteAction]>([
    ["a staff action", staffTouch],
    ["another module's action", foreignModuleTouch],
    ["a non-idempotent action that enqueues", nonIdempotentEnqueuer],
  ])("refuses %s", async (_label, action) => {
    await expect(
      executeJobAction(kit.pipeline, {
        job: touchJob,
        envelope: touchEnvelope(),
        action,
        input: { customerId: sentinelId() },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    expect(kit.jobs.sent).toHaveLength(0);
  });
});

describe("jobIsolationCase", () => {
  const own = { payload: { customerId: kitIdentities.crmSentinel } };
  const foreign = { payload: { customerId: foreignCustomerId } };

  it("fails an action whose own run commits no ok audit row in the recorded company", async () => {
    await expect(
      runJobIsolationCase(
        kit,
        jobIsolationCase(touchJob, peekNothing, own, foreign),
      ),
    ).rejects.toThrow(/committed no ok audit row in company/);
  });

  it("runs the case's effect assertion on the own run instead of the audit check", async () => {
    const seen: { requestId: string; companyId: string | null }[] = [];

    await expect(
      runJobIsolationCase(
        kit,
        jobIsolationCase(touchJob, peekNothing, own, foreign, (_kit, run) => {
          seen.push(run);
          return Promise.reject(new Error("peekNothing changed nothing"));
        }),
      ),
    ).rejects.toThrow(/peekNothing changed nothing/);
    expect(seen).toEqual([
      { requestId: expect.any(String) as string, companyId: companyA() },
    ]);
  });

  it("passes an action that loads rows by the recorded company", async () => {
    await runJobIsolationCase(
      kit,
      jobIsolationCase(touchJob, touchCustomer, own, foreign),
    );
    expect(await displayNameOf(foreignCustomerId)).toBe("Company B customer");
  });

  it("keeps only the own run's envelopes when the failing runs enqueued before they were refused", async () => {
    await runJobIsolationCase(
      kit,
      jobIsolationCase(touchJob, enqueueThenTouch, own, foreign),
    );

    expect(kit.jobs.sent).toHaveLength(1);
    expect(kit.jobs.sent[0]?.payload).toEqual({
      customerId: kitIdentities.crmSentinel,
    });
  });

  it("fails an action that loads a payload's row by id alone", async () => {
    await expect(
      runJobIsolationCase(
        kit,
        jobIsolationCase(touchJob, leakyTouch, own, foreign),
      ),
    ).rejects.toThrow(/to be denied/);
  });

  it("refuses a tenant job case without a foreign payload", async () => {
    await expect(
      runJobIsolationCase(kit, jobIsolationCase(touchJob, touchCustomer, own)),
    ).rejects.toThrow(/needs a foreign payload/);
  });

  it("passes a periodic fan-out action that loads the fan-out company's owned rows", async () => {
    const foreignBefore = await displayNameOf(foreignCustomerId);

    await runJobIsolationCase(
      kit,
      jobIsolationCase(sweepJob, renameForCompany, {
        payload: { kind: "daily" },
      }),
    );

    expect(await displayNameOf(sentinelId())).toBe("swept");
    expect(await displayNameOf(foreignCustomerId)).toBe(foreignBefore);
  });

  it("fails a periodic fan-out action that succeeds for a company without owned rows", async () => {
    await expect(
      runJobIsolationCase(
        kit,
        jobIsolationCase(sweepJob, leakyRenameForCompany, {
          payload: { kind: "daily" },
        }),
      ),
    ).rejects.toThrow(/without owned rows.*to be denied/);
  });

  describe("global branch: execution scope", () => {
    const daily = { payload: { kind: "daily" } };

    it("runs a global job's global action with no company and checks its audit row", async () => {
      const seen: { requestId: string; companyId: string | null }[] = [];

      await runJobIsolationCase(
        kit,
        jobIsolationCase(
          sweepJob,
          sweepGlobal,
          daily,
          undefined,
          (_kit, run) => {
            seen.push(run);
            return Promise.resolve();
          },
        ),
      );

      expect(seen).toEqual([
        { requestId: expect.any(String) as string, companyId: null },
      ]);
      const [audit] = await kit.db.runtime.db
        .select({
          companyId: auditLog.companyId,
          actorId: auditLog.actorId,
          outcome: auditLog.outcome,
        })
        .from(auditLog)
        .where(eq(auditLog.requestId, seen[0]?.requestId ?? ""));
      expect(audit).toEqual({
        companyId: null,
        actorId: sweepJob.name,
        outcome: "ok",
      });
    });

    it("fails a global case whose effect does not hold", async () => {
      await expect(
        runJobIsolationCase(
          kit,
          jobIsolationCase(sweepJob, sweepGlobal, daily, undefined, () =>
            Promise.reject(new Error("nothing swept")),
          ),
        ),
      ).rejects.toThrow(/nothing swept/);
    });

    it("refuses a tenant job that runs a global action", async () => {
      await expect(
        runJobIsolationCase(
          kit,
          jobIsolationCase(touchJob, sweepGlobal, {
            payload: { customerId: kitIdentities.crmSentinel },
          }),
        ),
      ).rejects.toThrow(/is a tenant job and cannot run global action/);
    });

    it("refuses an unaudited global action without an effect assertion", async () => {
      const quietGlobal = implementAction(
        defineActionContract({
          ...systemRead,
          systemScope: "global",
          name: "jobRun.quietGlobal",
          description: "Unaudited global read fixture.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          errors: [],
        }),
        { handler: () => Promise.resolve({ ok: true }) },
      );

      await expect(
        runJobIsolationCase(
          kit,
          jobIsolationCase(sweepJob, quietGlobal, daily),
        ),
      ).rejects.toThrow(/unaudited global action.*supply an effect assertion/);
    });

    it("refuses a global case that names a foreign payload", async () => {
      await expect(
        runJobIsolationCase(
          kit,
          jobIsolationCase(sweepJob, sweepGlobal, daily, daily),
        ),
      ).rejects.toThrow(/no foreign company to refuse/);
    });
  });
});
