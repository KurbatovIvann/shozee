/**
 * The `assistant` queue on the job host (ADR-0039, SHO-569), against a real
 * Redis: a turn's job runs once, is never re-run after its worker disappears,
 * is refused under a second id while it exists, and lives on the queue Redis
 * only. The turn itself is the processor's (`@showzy/assistant-runtime`, tested
 * against Postgres in `apps/api`); here it is a stub that counts and waits.
 *
 * The shared and the queue Redis are two logical databases of one container, so
 * a key on the wrong one is visible to the test.
 */
import { randomUUID } from "node:crypto";

import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  ASSISTANT_TURN_JOB_NAME,
  assistantTurnJobId,
  enqueueAssistantTurn,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
} from "@showzy/assistant-runtime";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJobHost, type JobHost } from "./jobs.js";
import {
  ASSISTANT_LOCK_DURATION_MS,
  ASSISTANT_MAX_STALLED_COUNT,
  ASSISTANT_QUEUE_CONCURRENCY,
} from "./policy.js";

const silent = pino({ enabled: false });
const LONG_INTERVAL_MS = 60 * 60 * 1_000;

let kit: TestKit;
let container: StartedRedisContainer;
let sharedUrl: string;
let queueUrl: string;

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  sharedUrl = `${container.getConnectionUrl()}/0`;
  queueUrl = `${container.getConnectionUrl()}/1`;
}, 180_000);

afterAll(async () => {
  await kit.db.close();
  await container.stop();
});

beforeEach(async () => {
  const admin = new Redis(container.getConnectionUrl());
  await admin.flushall();
  await admin.quit();
});

function turnJob(): AssistantTurnJob {
  return {
    version: 1,
    kind: "chat",
    conversationId: randomUUID(),
    commandId: randomUUID(),
  };
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the assistant queue");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A processor whose runs are counted and held until released. */
function gatedProcessor() {
  const runs: AssistantTurnJob[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    runs,
    release: () => {
      open();
    },
    process: async (
      job: AssistantTurnJob,
    ): Promise<AssistantTurnJobOutcome> => {
      runs.push(job);
      await gate;
      return { kind: "finished", status: "done", reachedModel: true };
    },
  };
}

function hostWith(
  process: (job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome>,
  seams: { lockDurationMs?: number; stalledIntervalMs?: number } = {},
): JobHost {
  return createJobHost({
    redisUrl: sharedUrl,
    db: kit.db.runtime.db,
    logger: silent,
    workerId: `assistant-${randomUUID()}`,
    cleanupIntervalMs: LONG_INTERVAL_MS,
    sweepIntervalMs: LONG_INTERVAL_MS,
    backfillIntervalMs: LONG_INTERVAL_MS,
    cleanup: () => Promise.resolve(0),
    sweep: () =>
      Promise.resolve({
        leftoverStagingDeleted: 0,
        abandonedPendingDeleted: 0,
      }),
    backfill: () =>
      Promise.resolve({
        filled: 0,
        alreadyComplete: 0,
        skippedMissingOriginal: 0,
        skippedUndecodable: 0,
      }),
    assistant: { redisUrl: queueUrl, process, ...seams },
  });
}

async function withQueue<T>(run: (queue: Queue) => Promise<T>): Promise<T> {
  const connection = new Redis(queueUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(ASSISTANT_QUEUE_NAME, {
    connection,
    prefix: ASSISTANT_QUEUE_PREFIX,
  });
  try {
    return await run(queue);
  } finally {
    await queue.close();
    await connection.quit();
  }
}

async function pendingJobs(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

describe("the assistant queue policy", () => {
  it("states ADR-0039's starting values", () => {
    expect(ASSISTANT_QUEUE_CONCURRENCY).toBe(4);
    expect(ASSISTANT_LOCK_DURATION_MS).toBe(60_000);
    expect(ASSISTANT_MAX_STALLED_COUNT).toBe(0);
  });
});

describe("a turn's job on the job host", () => {
  it("is enqueued under the turn's id with one attempt, on the queue Redis only", async () => {
    const gated = gatedProcessor();
    const host = hostWith(gated.process);
    await host.start();
    const job = turnJob();
    try {
      await withQueue(async (queue) => {
        await enqueueAssistantTurn(queue, job);
        await waitUntil(() => gated.runs.length === 1);

        const stored = await queue.getJob(assistantTurnJobId(job));
        expect(stored?.name).toBe(ASSISTANT_TURN_JOB_NAME);
        expect(stored?.data).toEqual(job);
        expect(stored?.opts).toMatchObject({
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      });

      const shared = new Redis(sharedUrl);
      const onShared = await shared.keys(
        `${ASSISTANT_QUEUE_PREFIX}:${ASSISTANT_QUEUE_NAME}:*`,
      );
      await shared.quit();
      expect(onShared).toEqual([]);
      expect(gated.runs).toEqual([job]);
    } finally {
      gated.release();
      await host.close();
    }
  });

  it("refuses a second job under the same id while the first exists, and runs the turn once", async () => {
    const gated = gatedProcessor();
    const host = hostWith(gated.process);
    await host.start();
    const job = turnJob();
    try {
      await withQueue(async (queue) => {
        await enqueueAssistantTurn(queue, job);
        await waitUntil(() => gated.runs.length === 1);
        // A retried accept, or the reconciler, while the turn is running.
        await enqueueAssistantTurn(queue, { ...job });
        gated.release();
        await waitUntil(async () => (await pendingJobs(queue)) === 0);
      });
      expect(gated.runs).toHaveLength(1);
    } finally {
      gated.release();
      await host.close();
    }
  });

  it("fails a stalled job and never runs it again", async () => {
    const job = turnJob();
    const jobId = assistantTurnJobId(job);
    // The worker that took the turn and then disappeared: it holds the job, and
    // its lock is never renewed.
    const crashedConnection = new Redis(queueUrl, {
      maxRetriesPerRequest: null,
    });
    let taken = false;
    const crashed = new Worker(
      ASSISTANT_QUEUE_NAME,
      () => {
        taken = true;
        return new Promise<never>(() => undefined);
      },
      {
        connection: crashedConnection,
        prefix: ASSISTANT_QUEUE_PREFIX,
        lockDuration: 1_000,
        skipLockRenewal: true,
        skipStalledCheck: true,
      },
    );
    const eventsConnection = new Redis(queueUrl, {
      maxRetriesPerRequest: null,
    });
    const events = new QueueEvents(ASSISTANT_QUEUE_NAME, {
      connection: eventsConnection,
      prefix: ASSISTANT_QUEUE_PREFIX,
    });
    const failed: { jobId: string; failedReason: string }[] = [];
    events.on("failed", (args) => {
      failed.push(args);
    });
    await events.waitUntilReady();

    const survivor = gatedProcessor();
    let host: JobHost | undefined;
    try {
      await withQueue(async (queue) => {
        await enqueueAssistantTurn(queue, job);
        await waitUntil(() => taken);

        host = hostWith(survivor.process, {
          lockDurationMs: 1_000,
          stalledIntervalMs: 300,
        });
        await host.start();

        await waitUntil(() => failed.some((entry) => entry.jobId === jobId));
        expect(
          failed.find((entry) => entry.jobId === jobId)?.failedReason,
        ).toMatch(/stalled/);
        // Failed and removed: nothing is left to run again.
        expect(await queue.getJob(jobId)).toBeUndefined();
      });
      expect(survivor.runs).toEqual([]);
    } finally {
      survivor.release();
      await crashed.close(true);
      await crashedConnection.quit();
      await events.close();
      await eventsConnection.quit();
      await host?.close();
    }
  });

  it("runs a processor that throws once, and does not retry it", async () => {
    let runs = 0;
    const host = hostWith(() => {
      runs += 1;
      return Promise.reject(new Error("the turn store is down"));
    });
    await host.start();
    try {
      await withQueue(async (queue) => {
        await enqueueAssistantTurn(queue, turnJob());
        await waitUntil(
          async () => runs === 1 && (await pendingJobs(queue)) === 0,
        );
      });
      expect(runs).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("drops a job that is not a turn's identity under its own id, without running it", async () => {
    const gated = gatedProcessor();
    gated.release();
    const host = hostWith(gated.process);
    await host.start();
    const job = turnJob();
    try {
      await withQueue(async (queue) => {
        // A payload with more than the identity, and an identity under an id
        // it does not derive: neither is a turn's job.
        await queue.add(
          ASSISTANT_TURN_JOB_NAME,
          { ...job, userId: "someone" },
          { jobId: assistantTurnJobId(job), removeOnComplete: true },
        );
        await queue.add(ASSISTANT_TURN_JOB_NAME, turnJob(), {
          jobId: `turn.chat.${randomUUID()}.${randomUUID()}`,
          removeOnComplete: true,
        });
        await waitUntil(async () => (await pendingJobs(queue)) === 0);
      });
      expect(gated.runs).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
