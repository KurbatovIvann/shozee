import { randomUUID } from "node:crypto";

import {
  auditLog,
  companies,
  domainEvents,
  type ReadTx,
  type Tx,
} from "@showzy/db";
import { fixtureCrmCustomers } from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { CoreInvariantError, NotFoundError } from "../../errors/index.js";
import { defineJob } from "../../jobs/define-job.js";
import { jobField, jobPayload } from "../../jobs/job-payload.js";
import {
  buildJobEnvelope,
  createTestKit,
  type TestKit,
} from "../../testing/kit.js";
import { kitIdentities } from "../../testing/identities.js";
import {
  jobIsolationCase,
  runJobIsolationCase,
  type SuiteAction,
} from "../../testing/suites.js";
import { defineEvent } from "../events/define-event.js";
import { implementAction } from "../implement-action.js";
import type { ActionPipelineDeps } from "../pipeline/types.js";
import { executeJobAction } from "./execute-job-action.js";

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

const readTouch = implementAction(
  defineActionContract({
    ...systemWrite,
    risk: "read",
    name: "jobRun.readTouch",
    description: "Read fixture.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    idempotent: false,
    audit: true,
    emits: [],
    errors: [],
  }),
  { handler: () => Promise.resolve({ ok: true }), auditTarget },
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
        envelope,
        action: touchCustomer,
        input: { customerId: sentinelId() },
      });

    await expect(run(failingAuditDeps())).rejects.toBeInstanceOf(
      CoreInvariantError,
    );
    await run(kit.pipeline);
    const [failedAttempt, retry] = kit.jobs.sent;
    expect(kit.jobs.sent).toHaveLength(2);
    expect(retry?.id).toBe(failedAttempt?.id);

    await run(kit.pipeline);
    expect(runs.touch).toBe(2);
    expect(kit.jobs.sent).toHaveLength(2);
  });

  it("fails closed when the recorded company does not exist", async () => {
    const before = await displayNameOf(sentinelId());

    await expect(
      executeJobAction(kit.pipeline, {
        envelope: touchEnvelope({ companyId: randomUUID() }),
        action: touchCustomer,
        input: { customerId: sentinelId() },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(runs.touch).toBe(0);
    expect(await displayNameOf(sentinelId())).toBe(before);
  });

  it("runs a global action of a periodic job with no company", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        envelope: buildJobEnvelope(sweepJob, {
          companyId: null,
          payload: { kind: "daily" },
        }),
        action: sweepGlobal,
        input: {},
      }),
    ).resolves.toEqual({ scope: "global" });
  });

  it("fans a periodic job out to a company without rows and changes nothing", async () => {
    const sentinelBefore = await displayNameOf(sentinelId());
    const foreignBefore = await displayNameOf(foreignCustomerId);
    const emptyCompany = randomUUID();
    await kit.db.runtime.db.insert(companies).values({
      id: emptyCompany,
      name: "Empty company",
      slug: `empty-${emptyCompany}`,
      prefix: "EM",
    });

    await expect(
      executeJobAction(kit.pipeline, {
        envelope: buildJobEnvelope(sweepJob, {
          companyId: null,
          payload: { kind: "daily" },
        }),
        action: renameForCompany,
        input: {},
        fanOutCompanyId: emptyCompany,
      }),
    ).resolves.toEqual({ changed: 0 });

    expect(await displayNameOf(sentinelId())).toBe(sentinelBefore);
    expect(await displayNameOf(foreignCustomerId)).toBe(foreignBefore);
  });

  it("refuses to fan a tenant job out to another company", async () => {
    await expect(
      executeJobAction(kit.pipeline, {
        envelope: touchEnvelope(),
        action: renameForCompany,
        input: {},
        fanOutCompanyId: companyB(),
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it.each<[string, SuiteAction]>([
    ["a staff action", staffTouch],
    ["another module's action", foreignModuleTouch],
    ["a read action", readTouch],
    ["a non-idempotent action that enqueues", nonIdempotentEnqueuer],
  ])("refuses %s", async (_label, action) => {
    await expect(
      executeJobAction(kit.pipeline, {
        envelope: touchEnvelope(),
        action,
        input: { customerId: sentinelId() },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    expect(kit.jobs.sent).toHaveLength(0);
  });
});

describe("jobIsolationCase", () => {
  const own = {
    payload: { customerId: kitIdentities.crmSentinel },
    input: { customerId: kitIdentities.crmSentinel },
  };
  const foreign = {
    payload: { customerId: foreignCustomerId },
    input: { customerId: foreignCustomerId },
  };

  it("passes an action that loads rows by the recorded company", async () => {
    await runJobIsolationCase(
      kit,
      jobIsolationCase(touchJob, touchCustomer, own, foreign),
    );
    expect(await displayNameOf(foreignCustomerId)).toBe("Company B customer");
  });

  it("fails an action that loads a payload's row by id alone", async () => {
    await expect(
      runJobIsolationCase(
        kit,
        jobIsolationCase(touchJob, leakyTouch, own, foreign),
      ),
    ).rejects.toThrow(/to be denied/);
  });
});
