import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  defineJob,
  implementAction,
  jobField,
  jobPayload,
  type ImplementedAction,
  type Job,
  type JobEnvelope,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import type { ReadTx, Tx } from "@showzy/db";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { fixtureCrmCustomers } from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRunner, JobRunnerRole } from "./job-runner.js";
import { exhaustedQueueName } from "./queue-provisioning.js";
import type { JobAttempt, JobHandler } from "./worker-host.js";

export interface RunnerJobRecord {
  readonly id: string;
  readonly state: string;
  readonly output: unknown;
  readonly sourceId: string | null;
}

export interface ScheduledTick {
  readonly slot: string;
  readonly state: string;
}

export interface ScheduledRuns {
  readonly jobs: readonly RunnerJobRecord[];
  readonly ticks: readonly ScheduledTick[];
}

export interface JobRunnerConformanceTarget {
  readonly adapter: string;
  open(
    database: TestDatabase,
    jobs: readonly Job[],
    role: JobRunnerRole,
    onError: (error: Error) => void,
  ): Promise<JobRunner>;
  readStoredJobData(
    database: TestDatabase,
    name: string,
    id: string,
  ): Promise<unknown>;
  rewriteStoredJobData(
    database: TestDatabase,
    name: string,
    id: string,
    data: unknown,
  ): Promise<void>;
  readJobs(
    database: TestDatabase,
    name: string,
  ): Promise<readonly RunnerJobRecord[]>;
  readScheduledRuns(
    database: TestDatabase,
    name: string,
  ): Promise<ScheduledRuns>;
  abandonAttempt(
    database: TestDatabase,
    name: string,
    id: string,
  ): Promise<void>;
  passRetention(
    database: TestDatabase,
    name: string,
    id: string,
  ): Promise<void>;
}

class RollbackProbe extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const subjectPayload = jobPayload({
  subjectId: jobField.uuid(),
  step: jobField.enum(["first", "second"]),
});

function conformanceJob(
  name: string,
  retries = 0,
  onExhausted = "conformance.interrupt",
  attemptTimeoutMs = 1_500,
): Job {
  return defineJob({
    name: `conformance.${name}`,
    scope: "tenant",
    payload: subjectPayload,
    discriminator: [],
    lifecycle: "expires",
    onExhausted,
    retries,
    attemptTimeoutMs,
  });
}

function envelopeFor(
  job: Job,
  companyId: string = randomUUID(),
  subjectId: string = randomUUID(),
): JobEnvelope {
  return {
    id: randomUUID(),
    name: job.name,
    companyId,
    actor: { type: "user", id: randomUUID() },
    channel: "ai",
    requestId: randomUUID(),
    correlationId: randomUUID(),
    executionId: randomUUID(),
    payload: { subjectId, step: "first" },
  };
}

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
  idempotent: false,
  audit: true,
  emits: [],
} as const;

const noOutput = jobPayload({});
const auditTarget = () => ({ type: "customer", id: "conformance" });

function writable(db: ReadTx | Tx): Tx {
  if (!("insert" in db)) {
    throw new CoreInvariantError("conformance expected a write transaction");
  }
  return db;
}

const interrupt = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "conformance.interrupt",
    description: "Ends the fixture row of an exhausted conformance job.",
    input: subjectPayload,
    output: noOutput,
    errors: [],
  }),
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError("conformance expected a tenant scope");
      }
      await writable(ctx.db)
        .update(fixtureCrmCustomers)
        .set({ displayName: "interrupted" })
        .where(
          and(
            eq(fixtureCrmCustomers.id, input.subjectId),
            eq(fixtureCrmCustomers.companyId, ctx.companyId),
          ),
        );
      return {};
    },
    auditTarget,
  },
);

const interruptFails = implementAction(
  defineActionContract({
    ...systemWrite,
    name: "conformance.interruptFails",
    description: "An on-exhausted action that cannot end its row.",
    input: subjectPayload,
    output: noOutput,
    errors: ["NOT_FOUND"],
  }),
  { handler: () => Promise.reject(new NotFoundError()), auditTarget },
);

const tickScope = implementAction(
  defineActionContract({
    ...systemWrite,
    systemScope: "global",
    name: "conformance.tick",
    description: "Reports the scope a periodic run executes in.",
    input: noOutput,
    output: jobPayload({ scope: jobField.enum(["tenant", "global"]) }),
    errors: [],
  }),
  {
    handler: (_input, ctx) => Promise.resolve({ scope: ctx.scope }),
    auditTarget,
  },
);

function handlerFor(
  job: Job,
  handle: (attempt: JobAttempt) => Promise<void>,
  onExhausted: ImplementedAction | null = interrupt,
): JobHandler {
  return onExhausted === null ? { job, handle } : { job, onExhausted, handle };
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) {
      return value;
    }
    await delay(250);
  }
}

function wellFormedStoredData(envelope: JobEnvelope): Record<string, unknown> {
  return {
    companyId: envelope.companyId,
    actor: envelope.actor,
    channel: envelope.channel,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    executionId: envelope.executionId,
    payload: envelope.payload,
  };
}

const hang = (): Promise<void> => new Promise<void>(() => undefined);

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

export function describeJobRunnerConformance(
  target: JobRunnerConformanceTarget,
): void {
  describe(`job runner conformance: ${target.adapter}`, () => {
    let database: TestDatabase;
    let kit: TestKit;
    const opened = new Set<JobRunner>();
    const runnerErrors: Error[] = [];

    async function subjectRow(): Promise<string> {
      const id = randomUUID();
      await database.runtime.db.insert(fixtureCrmCustomers).values({
        id,
        companyId: kit.identities.companies.a,
        userId: null,
        displayName: "running",
      });
      return id;
    }

    async function subjectName(id: string): Promise<string | undefined> {
      const [row] = await database.runtime.db
        .select({ displayName: fixtureCrmCustomers.displayName })
        .from(fixtureCrmCustomers)
        .where(eq(fixtureCrmCustomers.id, id));
      return row?.displayName;
    }

    async function enqueueSubject(
      runner: JobRunner,
      job: Job,
    ): Promise<{ envelope: JobEnvelope; subjectId: string }> {
      const subjectId = await subjectRow();
      const envelope = envelopeFor(job, kit.identities.companies.a, subjectId);
      await database.runtime.db.transaction(async (tx) => {
        await runner.port.enqueue(tx, [envelope]);
      });
      return { envelope, subjectId };
    }

    async function work(
      runner: JobRunner,
      handlers: readonly JobHandler[],
      drainTimeoutMs = 2_000,
    ): Promise<void> {
      await runner.work({ deps: kit.pipeline, handlers, drainTimeoutMs });
    }

    async function jobRecord(
      name: string,
      id: string,
    ): Promise<RunnerJobRecord | undefined> {
      const records = await target.readJobs(database, name);
      return records.find((record) => record.id === id);
    }

    function exhaustedRecords(job: Job): Promise<readonly RunnerJobRecord[]> {
      return target.readJobs(database, exhaustedQueueName(job));
    }

    async function open(
      jobs: readonly Job[],
      role: JobRunnerRole,
    ): Promise<JobRunner> {
      const runner = await target.open(database, jobs, role, (error) => {
        runnerErrors.push(error);
      });
      opened.add(runner);
      return runner;
    }

    async function close(runner: JobRunner): Promise<void> {
      opened.delete(runner);
      await runner.close();
    }

    beforeAll(async () => {
      database = await createTestDatabase();
      kit = await createTestKit(database);
    });

    afterEach(async () => {
      const closing = await Promise.allSettled([...opened].map(close));
      const reported = runnerErrors.splice(0);
      const closeFailures: unknown[] = closing
        .filter((result) => result.status === "rejected")
        .map((result): unknown => result.reason);
      expect({ reported, closeFailures }).toEqual({
        reported: [],
        closeFailures: [],
      });
    });

    afterAll(async () => {
      await database.close();
    });

    describe("J1 atomic enqueue", () => {
      it("a rolled-back transaction leaves no job", async () => {
        const job = conformanceJob("j1Rollback");
        const runner = await open([job], "worker");
        const envelope = envelopeFor(job);

        await expect(
          database.runtime.db.transaction(async (tx) => {
            await runner.port.enqueue(tx, [envelope]);
            throw new RollbackProbe();
          }),
        ).rejects.toBeInstanceOf(RollbackProbe);

        await expect(
          target.readStoredJobData(database, job.name, envelope.id),
        ).resolves.toBeUndefined();
      });

      it("a committed transaction creates the job", async () => {
        const job = conformanceJob("j1Commit");
        const runner = await open([job], "worker");
        const envelope = envelopeFor(job);

        await database.runtime.db.transaction(async (tx) => {
          await runner.port.enqueue(tx, [envelope]);
        });

        await expect(
          target.readStoredJobData(database, job.name, envelope.id),
        ).resolves.toBeDefined();
      });

      it("an api runner sends into a queue the worker provisioned", async () => {
        const job = conformanceJob("j1ApiSend");
        await open([job], "worker");
        const api = await open([job], "api");
        const envelope = envelopeFor(job);

        await database.runtime.db.transaction(async (tx) => {
          await api.port.enqueue(tx, [envelope]);
        });

        await expect(
          target.readStoredJobData(database, job.name, envelope.id),
        ).resolves.toBeDefined();
      });

      it("a job id the runner still holds is refused and rolls the transaction back", async () => {
        const job = conformanceJob("j1HeldId");
        const runner = await open([job], "worker");
        const first = envelopeFor(job);
        await database.runtime.db.transaction(async (tx) => {
          await runner.port.enqueue(tx, [first]);
        });

        const second = envelopeFor(job);
        await expect(
          database.runtime.db.transaction(async (tx) => {
            await runner.port.enqueue(tx, [second]);
            await runner.port.enqueue(tx, [
              { ...first, executionId: second.executionId },
            ]);
          }),
        ).rejects.toBeInstanceOf(CoreInvariantError);

        await expect(
          target.readStoredJobData(database, job.name, second.id),
        ).resolves.toBeUndefined();
      });
    });

    describe("J6 stored job data", () => {
      it("holds the envelope's ids and payload identity only", async () => {
        const job = conformanceJob("j6Identity");
        const runner = await open([job], "worker");
        const envelope = envelopeFor(job);
        await database.runtime.db.transaction(async (tx) => {
          await runner.port.enqueue(tx, [envelope]);
        });

        const stored = await target.readStoredJobData(
          database,
          job.name,
          envelope.id,
        );
        expect(stored).toEqual(wellFormedStoredData(envelope));
        const fixedValues = new Set([
          envelope.channel,
          envelope.actor.type,
          "first",
        ]);
        for (const leaf of stringLeaves(stored)) {
          expect(UUID.test(leaf) || fixedValues.has(leaf)).toBe(true);
        }
      });

      const malformations: readonly {
        readonly label: string;
        readonly jobName: string;
        readonly malform: (envelope: JobEnvelope) => Record<string, unknown>;
      }[] = [
        {
          label: "an unknown actor type",
          jobName: "j6MalformedActorType",
          malform: (envelope) => ({
            ...wellFormedStoredData(envelope),
            actor: { type: "robot", id: envelope.actor.id },
          }),
        },
        {
          label: "an unknown top-level key",
          jobName: "j6MalformedTopKey",
          malform: (envelope) => ({
            ...wellFormedStoredData(envelope),
            scope: "tenant",
          }),
        },
        {
          label: "an unknown actor key",
          jobName: "j6MalformedActorKey",
          malform: (envelope) => ({
            ...wellFormedStoredData(envelope),
            actor: { ...envelope.actor, role: "owner" },
          }),
        },
      ];

      it.each(malformations)(
        "a stored envelope with $label fails both queues with a typed code before any handler runs",
        async ({ jobName, malform }) => {
          const job = conformanceJob(jobName);
          const runner = await open([job], "worker");
          const { envelope, subjectId } = await enqueueSubject(runner, job);
          await target.rewriteStoredJobData(
            database,
            job.name,
            envelope.id,
            malform(envelope),
          );
          let runs = 0;

          await work(runner, [
            handlerFor(job, () => {
              runs += 1;
              return Promise.resolve();
            }),
          ]);

          await expect(
            eventually(
              () => jobRecord(job.name, envelope.id),
              (record) => record?.state === "failed",
            ),
          ).resolves.toMatchObject({
            state: "failed",
            output: { code: "INTERNAL" },
          });
          const exhausted = await eventually(
            () => exhaustedRecords(job),
            (records) => records.some(({ state }) => state === "failed"),
          );
          expect(exhausted).toMatchObject([
            { state: "failed", output: { code: "INTERNAL" } },
          ]);
          expect(runs).toBe(0);
          await expect(subjectName(subjectId)).resolves.toBe("running");
        },
      );
    });

    describe("J7 declared queue settings", () => {
      it("a worker boot provisions the declaration and a second boot accepts it", async () => {
        const job = conformanceJob("j7Stable", 1);
        await close(await open([job], "worker"));
        await expect(open([job], "worker")).resolves.toBeDefined();
        await expect(open([job], "api")).resolves.toBeDefined();
      });

      it("a changed declaration refuses boot in both roles", async () => {
        const job = conformanceJob("j7Changed", 1);
        await close(await open([job], "worker"));
        const changed = conformanceJob("j7Changed", 2);

        await expect(open([changed], "worker")).rejects.toBeInstanceOf(
          CoreInvariantError,
        );
        await expect(open([changed], "api")).rejects.toBeInstanceOf(
          CoreInvariantError,
        );
      });

      it("an api boot against an unprovisioned queue fails fast and provisions nothing", async () => {
        const job = conformanceJob("j7Unprovisioned");

        await expect(open([job], "api")).rejects.toBeInstanceOf(
          CoreInvariantError,
        );
        await expect(open([job], "api")).rejects.toBeInstanceOf(
          CoreInvariantError,
        );
      });

      it("a thrown attempt is retried at most the declared times and stores a typed code only", async () => {
        const job = conformanceJob("j7Thrown", 1);
        const runner = await open([job], "worker");
        const secret = `leaked ${randomUUID()}`;
        let runs = 0;
        const { envelope, subjectId } = await enqueueSubject(runner, job);

        await work(runner, [
          handlerFor(job, () => {
            runs += 1;
            return Promise.reject(new CoreInvariantError(secret));
          }),
        ]);

        await expect(
          eventually(
            () => subjectName(subjectId),
            (name) => name === "interrupted",
          ),
        ).resolves.toBe("interrupted");
        await delay(1_500);
        expect(runs).toBe(2);
        const stored = await jobRecord(job.name, envelope.id);
        expect(stored).toMatchObject({
          state: "failed",
          output: { code: "INTERNAL" },
        });
        const exhausted = await exhaustedRecords(job);
        expect(exhausted).toMatchObject([{ state: "completed" }]);
        expect(JSON.stringify([stored, exhausted])).not.toContain(secret);
      });

      it("an attempt past a whole-second timeout is aborted in process and stores ATTEMPT_TIMEOUT", async () => {
        const job = conformanceJob("j7Timeout", 0, undefined, 2_000);
        const runner = await open([job], "worker");
        let aborted = false;
        const { envelope, subjectId } = await enqueueSubject(runner, job);

        await work(runner, [
          handlerFor(job, (attempt) => {
            attempt.signal.addEventListener("abort", () => {
              aborted = true;
            });
            return hang();
          }),
        ]);

        await expect(
          eventually(
            () => subjectName(subjectId),
            (name) => name === "interrupted",
          ),
        ).resolves.toBe("interrupted");
        expect(aborted).toBe(true);
        await expect(jobRecord(job.name, envelope.id)).resolves.toMatchObject({
          state: "failed",
          output: { code: "ATTEMPT_TIMEOUT" },
        });
      });

      it("an abandoned attempt starts no further action", async () => {
        const job = conformanceJob("j7Abandoned");
        const runner = await open([job], "worker");
        let late: unknown;
        const { envelope } = await enqueueSubject(runner, job);

        await work(runner, [
          handlerFor(job, async (attempt) => {
            await new Promise<void>((resolve) => {
              attempt.signal.addEventListener("abort", () => {
                resolve();
              });
            });
            late = await attempt.run(interrupt, envelope.payload).then(
              () => "ran",
              (error: unknown) => error,
            );
          }),
        ]);

        await expect(
          eventually(
            () => Promise.resolve(late),
            (value) => value !== undefined,
          ),
        ).resolves.toBeInstanceOf(CoreInvariantError);
      });
    });

    describe("J9 exhausted work", () => {
      it("an expired last attempt reaches on-exhausted in the recorded scope", async () => {
        const job = conformanceJob("j9Expired");
        const runner = await open([job], "worker");
        let runs = 0;
        const { envelope, subjectId } = await enqueueSubject(runner, job);
        await target.abandonAttempt(database, job.name, envelope.id);

        await work(runner, [
          handlerFor(job, () => {
            runs += 1;
            return Promise.resolve();
          }),
        ]);

        await expect(
          eventually(
            () => subjectName(subjectId),
            (name) => name === "interrupted",
          ),
        ).resolves.toBe("interrupted");
        expect(runs).toBe(0);
        await expect(jobRecord(job.name, envelope.id)).resolves.toMatchObject({
          state: "failed",
        });
        await expect(
          eventually(
            () => exhaustedRecords(job),
            (records) =>
              records.length > 0 &&
              records.every(({ state }) => state === "completed"),
          ),
        ).resolves.toMatchObject([{ state: "completed" }]);
      });

      it("a failing on-exhausted action leaves the row for its module's sweep", async () => {
        const job = conformanceJob(
          "j9ExhaustFails",
          0,
          "conformance.interruptFails",
        );
        const runner = await open([job], "worker");
        const { subjectId } = await enqueueSubject(runner, job);

        await work(runner, [
          handlerFor(
            job,
            () => Promise.reject(new CoreInvariantError("attempt failed")),
            interruptFails,
          ),
        ]);

        const exhausted = await eventually(
          () => exhaustedRecords(job),
          (records) => records.some(({ state }) => state === "failed"),
        );
        expect(exhausted).toMatchObject([
          { state: "failed", output: { code: "NOT_FOUND" } },
        ]);
        await expect(subjectName(subjectId)).resolves.toBe("running");
      });

      it("a job dropped by retention sends nothing to the dead letter", async () => {
        const job = conformanceJob("j9Retention");
        const runner = await open([job], "worker");
        const { envelope, subjectId } = await enqueueSubject(runner, job);

        await target.passRetention(database, job.name, envelope.id);

        await expect(
          eventually(
            () => jobRecord(job.name, envelope.id),
            (record) => record === undefined,
          ),
        ).resolves.toBeUndefined();
        await expect(
          target.readJobs(database, exhaustedQueueName(job)),
        ).resolves.toEqual([]);
        await expect(subjectName(subjectId)).resolves.toBe("running");
      });
    });

    describe("periodic schedules", () => {
      it("two workers run one tick once, in the global scope", async () => {
        const job = defineJob({
          name: "conformance.j9Tick",
          scope: "global",
          payload: noOutput,
          discriminator: [],
          lifecycle: "periodic",
          cron: "* * * * *",
          retries: 0,
          attemptTimeoutMs: 1_500,
        });
        const runs: { id: string; scope: string }[] = [];
        const tick = handlerFor(
          job,
          async (attempt) => {
            const { scope } = await attempt.run(tickScope, {});
            runs.push({ id: attempt.envelope.id, scope });
          },
          null,
        );
        await work(await open([job], "worker"), [tick]);
        await work(await open([job], "worker"), [tick]);

        await eventually(
          () => Promise.resolve(runs.length),
          (count) => count > 0,
          75_000,
        );
        await delay(3_000);

        const { jobs, ticks, ranIds } = await eventually(
          async () => {
            const ranBeforeRead = runs.map(({ id }) => id);
            const scheduled = await target.readScheduledRuns(
              database,
              job.name,
            );
            return { ...scheduled, ranIds: ranBeforeRead };
          },
          (read) =>
            read.jobs.every(({ state }) => state === "completed") &&
            read.ticks.every(({ state }) => state === "completed") &&
            read.ranIds.length === read.jobs.length,
        );
        expect(ranIds.length).toBeGreaterThan(0);
        expect(new Set(ticks.map(({ slot }) => slot)).size).toBe(ticks.length);
        expect(jobs).toHaveLength(ticks.length);
        expect(new Set(ranIds).size).toBe(ranIds.length);
        expect([...ranIds].sort()).toEqual(jobs.map(({ id }) => id).sort());
        expect(runs.every(({ scope }) => scope === "global")).toBe(true);
      });
    });

    describe("drain", () => {
      it("stop waits for a running job up to the bound, then fails the rest with a typed code", async () => {
        const quick = conformanceJob("drainQuick", 0, undefined, 10_000);
        const stuck = conformanceJob("drainStuck", 0, undefined, 10_000);
        const runner = await open([quick, stuck], "worker");
        const started = new Set<string>();
        const quickJob = await enqueueSubject(runner, quick);
        const stuckJob = await enqueueSubject(runner, stuck);

        await work(
          runner,
          [
            handlerFor(quick, async () => {
              started.add(quick.name);
              await delay(500);
            }),
            handlerFor(stuck, () => {
              started.add(stuck.name);
              return hang();
            }),
          ],
          1_000,
        );
        await eventually(
          () => Promise.resolve(started.size),
          (size) => size === 2,
        );
        await close(runner);

        await expect(
          jobRecord(quick.name, quickJob.envelope.id),
        ).resolves.toMatchObject({ state: "completed" });
        await expect(
          jobRecord(stuck.name, stuckJob.envelope.id),
        ).resolves.toMatchObject({
          state: "failed",
          output: { code: "DRAINED" },
        });
      });

      it("an api runner refuses to work jobs", async () => {
        const job = conformanceJob("apiWork");
        await open([job], "worker");
        const api = await open([job], "api");

        await expect(
          work(api, [handlerFor(job, () => Promise.resolve())]),
        ).rejects.toBeInstanceOf(CoreInvariantError);
      });

      it("a worker refuses to boot when a declared job has no handler", async () => {
        const handled = conformanceJob("handledJob");
        const unhandled = conformanceJob("unhandledJob");
        const runner = await open([handled, unhandled], "worker");

        await expect(
          work(runner, [handlerFor(handled, () => Promise.resolve())]),
        ).rejects.toThrow(/declared job "[^"]*unhandledJob" has no handler/);
      });

      it("a worker refuses a handler for an undeclared job", async () => {
        const declared = conformanceJob("declaredOnly");
        const undeclared = conformanceJob("undeclaredJob");
        const runner = await open([declared], "worker");

        await expect(
          work(runner, [
            handlerFor(declared, () => Promise.resolve()),
            handlerFor(undeclared, () => Promise.resolve()),
          ]),
        ).rejects.toThrow(/job "[^"]*undeclaredJob" is not a declared job/);
      });

      it("a worker refuses a handler bound to a definition other than the declared one", async () => {
        const declared = conformanceJob("redefinedJob");
        const redefined = conformanceJob("redefinedJob", 3);
        const runner = await open([declared], "worker");

        await expect(
          work(runner, [handlerFor(redefined, () => Promise.resolve())]),
        ).rejects.toThrow(
          /job "[^"]*redefinedJob" binds a definition other than the declared one/,
        );
      });

      it("a worker refuses a duplicate handler", async () => {
        const job = conformanceJob("duplicateJob");
        const runner = await open([job], "worker");

        await expect(
          work(runner, [
            handlerFor(job, () => Promise.resolve()),
            handlerFor(job, () => Promise.resolve()),
          ]),
        ).rejects.toThrow(/job "[^"]*duplicateJob" has more than one handler/);
      });

      it("a worker refuses an on-exhausted binding other than the declaration", async () => {
        const job = conformanceJob("mismatchedExhaust");
        const runner = await open([job], "worker");

        await expect(
          work(runner, [
            handlerFor(job, () => Promise.resolve(), interruptFails),
          ]),
        ).rejects.toThrow(
          /declares on-exhausted "conformance.interrupt" but its handler binds "conformance.interruptFails"/,
        );
      });

      it("a worker refuses a periodic job outside the global scope", async () => {
        const job = defineJob({
          name: "conformance.tenantTick",
          scope: "tenant",
          payload: noOutput,
          discriminator: [],
          lifecycle: "periodic",
          cron: "* * * * *",
          retries: 0,
          attemptTimeoutMs: 1_500,
        });
        const runner = await open([job], "worker");

        await expect(
          work(runner, [handlerFor(job, () => Promise.resolve(), null)]),
        ).rejects.toThrow(
          /periodic job "conformance.tenantTick" must be global/,
        );
      });

      it("a worker refuses a second work call", async () => {
        const job = conformanceJob("secondWork");
        const runner = await open([job], "worker");
        const handlers = [handlerFor(job, () => Promise.resolve())];
        await work(runner, handlers);

        await expect(work(runner, handlers)).rejects.toThrow(
          /already works its handlers/,
        );
      });
    });
  });
}
