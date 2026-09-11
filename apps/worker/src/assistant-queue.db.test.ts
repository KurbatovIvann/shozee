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
  ASSISTANT_TURN_TIMEOUT_MS,
  assistantTurnJobId,
  enqueueAssistantTurn,
  type AssistantReconcileSummary,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
  type AssistantTurnQueue,
} from "@showzy/assistant-runtime";
import { createProcessLogger } from "@showzy/config";
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
  ASSISTANT_DRAIN_TIMEOUT_MS,
  ASSISTANT_LOCK_DURATION_MS,
  ASSISTANT_MAX_STALLED_COUNT,
  ASSISTANT_QUEUE_CONCURRENCY,
  ASSISTANT_RECONCILE_INTERVAL_MS,
  ASSISTANT_RECONCILE_JOB_NAME,
  BULLMQ_PREFIX,
  MAINTENANCE_QUEUE_NAME,
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
  seams: {
    lockDurationMs?: number;
    stalledIntervalMs?: number;
    reconcileIntervalMs?: number;
    reconcile?: (
      queue: AssistantTurnQueue,
    ) => Promise<AssistantReconcileSummary>;
  } = {},
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
    expect(ASSISTANT_RECONCILE_INTERVAL_MS).toBe(60_000);
    // A turn stops itself at its deadline and still has its last writes to make.
    expect(ASSISTANT_DRAIN_TIMEOUT_MS).toBeGreaterThan(
      ASSISTANT_TURN_TIMEOUT_MS,
    );
  });
});

describe("the reconciler on the maintenance scheduler", () => {
  const emptyPass = {
    listed: 0,
    reenqueued: 0,
    backedOff: 0,
    interrupted: 0,
    released: 0,
    left: 0,
    failed: 0,
  };

  it("runs on its own schedule and is handed the queue a turn is enqueued on", async () => {
    const gated = gatedProcessor();
    gated.release();
    const job = turnJob();
    const passes: AssistantTurnJob[][] = [];
    const host = hostWith(gated.process, {
      reconcileIntervalMs: 400,
      reconcile: async (queue) => {
        // What a pass does with a queued turn whose job was lost.
        await enqueueAssistantTurn(queue, job);
        passes.push([job]);
        return { ...emptyPass, listed: 1, reenqueued: 1 };
      },
    });
    await host.start();
    try {
      await waitUntil(() => passes.length >= 1);
      await waitUntil(() => gated.runs.length === 1);
      // The re-enqueued job went on the queue Redis, under the turn's own id.
      expect(gated.runs).toEqual([job]);
      const shared = new Redis(sharedUrl);
      const onShared = await shared.keys(
        `${ASSISTANT_QUEUE_PREFIX}:${ASSISTANT_QUEUE_NAME}:*`,
      );
      await shared.quit();
      expect(onShared).toEqual([]);
    } finally {
      gated.release();
      await host.close();
    }
  });

  it("is not scheduled by a worker that runs no turns", async () => {
    const host = createJobHost({
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
    });
    await host.start();
    try {
      const connection = new Redis(sharedUrl, { maxRetriesPerRequest: null });
      const maintenance = new Queue(MAINTENANCE_QUEUE_NAME, {
        connection,
        prefix: BULLMQ_PREFIX,
      });
      try {
        const scheduled = await maintenance.getJobSchedulers();
        expect(scheduled.map((entry) => entry.key)).not.toContain(
          ASSISTANT_RECONCILE_JOB_NAME,
        );
      } finally {
        await maintenance.close();
        await connection.quit();
      }
    } finally {
      await host.close();
    }
  });
});

describe("shutdown drains the turns this worker is running", () => {
  it("waits for an in-flight turn to finish, and lets its job complete", async () => {
    const gated = gatedProcessor();
    const host = hostWith(gated.process);
    await host.start();
    let closed = false;
    try {
      await withQueue(async (queue) => {
        await enqueueAssistantTurn(queue, turnJob());
        await waitUntil(() => gated.runs.length === 1);

        const closing = host.close().then(() => {
          closed = true;
        });
        // Still inside the turn: shutdown waits rather than dropping it.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(closed).toBe(false);

        gated.release();
        await closing;
        expect(closed).toBe(true);
        // Completed, not failed and not left waiting to be run again.
        expect(await pendingJobs(queue)).toBe(0);
      });
    } finally {
      gated.release();
      await host.close();
    }
  });

  /**
   * A turn that outlives the bound is not waited for for ever: the process says
   * so and goes, and its row is the reconciler's to interrupt — the same
   * recovery a worker that crashed gets.
   */
  it("stops waiting at the drain bound and says so", async () => {
    const lines: string[] = [];
    const logger = createProcessLogger({
      name: "assistant-drain",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    let entered = false;
    const host = createJobHost({
      redisUrl: sharedUrl,
      db: kit.db.runtime.db,
      logger,
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
      assistant: {
        redisUrl: queueUrl,
        drainTimeoutMs: 300,
        process: () => {
          entered = true;
          return new Promise<AssistantTurnJobOutcome>(() => undefined);
        },
      },
    });
    await host.start();
    await withQueue(async (queue) => {
      await enqueueAssistantTurn(queue, turnJob());
    });
    await waitUntil(() => entered);

    await host.close();

    expect(lines.join("\n")).toContain(
      "assistant turns still running at the drain timeout",
    );
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

  /**
   * A core error's message can name a person and a company, and BullMQ stores
   * a thrown job's message as its `failedReason` — in the job and in the queue's
   * event stream, which `removeOnFail` does not clear. ADR-0039: no personal
   * data on the queue's disk.
   */
  it("runs a processor that throws once, and keeps what it threw off the queue Redis", async () => {
    const sentinel = `SENTINEL-${randomUUID()}`;
    let runs = 0;
    const host = hostWith(() => {
      runs += 1;
      return Promise.reject(
        new Error(`no company_members row for user ${sentinel} in company`),
      );
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

      const raw = new Redis(queueUrl);
      try {
        const stream = await raw.xrange(
          `${ASSISTANT_QUEUE_PREFIX}:${ASSISTANT_QUEUE_NAME}:events`,
          "-",
          "+",
        );
        expect(stream.length).toBeGreaterThan(0);
        expect(JSON.stringify(stream)).not.toContain(sentinel);

        const everything: unknown[] = [];
        for (const key of await raw.keys("*")) {
          const type = await raw.type(key);
          if (type === "string") {
            everything.push(await raw.get(key));
          } else if (type === "hash") {
            everything.push(await raw.hgetall(key));
          } else if (type === "list") {
            everything.push(await raw.lrange(key, 0, -1));
          } else if (type === "set") {
            everything.push(await raw.smembers(key));
          } else if (type === "zset") {
            everything.push(await raw.zrange(key, "0", "-1"));
          } else if (type === "stream") {
            everything.push(await raw.xrange(key, "-", "+"));
          }
        }
        expect(JSON.stringify(everything)).not.toContain(sentinel);
      } finally {
        await raw.quit();
      }
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
