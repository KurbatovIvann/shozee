import { randomUUID } from "node:crypto";

import {
  defineJob,
  jobField,
  jobPayload,
  type Job,
  type JobEnvelope,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobRunner, JobRunnerRole } from "./job-runner.js";

export interface JobRunnerConformanceTarget {
  readonly adapter: string;
  open(
    database: TestDatabase,
    jobs: readonly Job[],
    role: JobRunnerRole,
  ): Promise<JobRunner>;
  readStoredJobData(
    database: TestDatabase,
    name: string,
    id: string,
  ): Promise<unknown>;
}

class RollbackProbe extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function conformanceJob(name: string, retries = 0): Job {
  return defineJob({
    name: `conformance.${name}`,
    scope: "tenant",
    payload: jobPayload({
      subjectId: jobField.uuid(),
      step: jobField.enum(["first", "second"]),
    }),
    discriminator: [],
    lifecycle: "expires",
    onExhausted: "conformance.interrupt",
    retries,
    attemptTimeoutMs: 1_500,
  });
}

function envelopeFor(job: Job): JobEnvelope {
  return {
    id: randomUUID(),
    name: job.name,
    companyId: randomUUID(),
    actor: { type: "user", id: randomUUID() },
    channel: "ai",
    requestId: randomUUID(),
    correlationId: randomUUID(),
    executionId: randomUUID(),
    payload: { subjectId: randomUUID(), step: "first" },
  };
}

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
    const opened: JobRunner[] = [];

    async function open(
      jobs: readonly Job[],
      role: JobRunnerRole,
    ): Promise<JobRunner> {
      const runner = await target.open(database, jobs, role);
      opened.push(runner);
      return runner;
    }

    beforeAll(async () => {
      database = await createTestDatabase();
    });

    afterAll(async () => {
      for (const runner of opened) {
        await runner.close();
      }
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
        expect(stored).toEqual({
          companyId: envelope.companyId,
          actor: envelope.actor,
          channel: envelope.channel,
          requestId: envelope.requestId,
          correlationId: envelope.correlationId,
          executionId: envelope.executionId,
          payload: envelope.payload,
        });
        const fixedValues = new Set([
          envelope.channel,
          envelope.actor.type,
          "first",
        ]);
        for (const leaf of stringLeaves(stored)) {
          expect(UUID.test(leaf) || fixedValues.has(leaf)).toBe(true);
        }
      });
    });

    describe("J7 declared queue settings", () => {
      it("a worker boot provisions the declaration and a second boot accepts it", async () => {
        const job = conformanceJob("j7Stable", 1);
        await open([job], "worker");
        await expect(open([job], "worker")).resolves.toBeDefined();
        await expect(open([job], "api")).resolves.toBeDefined();
      });

      it("a changed declaration refuses boot in both roles", async () => {
        const job = conformanceJob("j7Changed", 1);
        await open([job], "worker");
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
    });
  });
}
