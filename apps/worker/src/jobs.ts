/**
 * The `assistant` queue (ADR-0039, SHO-569) is the one durable queue, on its
 * own connection to the queue Redis, and is started only when a processor is
 * given. The host parses a job into a turn's identity and hands it to
 * `createAssistantTurnProcessor`; the turn is the processor's work.
 */
import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  ASSISTANT_TURN_JOB_NAME,
  assistantTurnJobId,
  assistantTurnJobSchema,
  type AssistantReconcileSummary,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
  type AssistantTurnQueue,
} from "@showzy/assistant-runtime";
import { CoreInvariantError } from "@showzy/core/errors";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";

import {
  ASSISTANT_DRAIN_TIMEOUT_MS,
  ASSISTANT_LOCK_DURATION_MS,
  ASSISTANT_MAX_STALLED_COUNT,
  ASSISTANT_QUEUE_CONCURRENCY,
  ASSISTANT_RECONCILE_INTERVAL_MS,
  ASSISTANT_RECONCILE_JOB_NAME,
  BULLMQ_PREFIX,
  MAINTENANCE_LOCK_DURATION_MS,
  MAINTENANCE_QUEUE_NAME,
} from "./policy.js";

export interface JobHost {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface AssistantJobHostOptions {
  /** The queue Redis (`config.queueRedis.url`), never the shared one. */
  readonly redisUrl: string;
  /** `createAssistantTurnProcessor` from `@showzy/assistant-runtime`. */
  readonly process: (job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome>;
  /**
   * `createAssistantTurnReconciler` from `@showzy/assistant-runtime`, run on
   * the maintenance scheduler. It is given this host's queue, the only one on
   * the queue Redis, so a turn it re-enqueues is added exactly as an accept
   * adds it. Absent: no reconciler, and its scheduler is removed.
   */
  readonly reconcile?: (
    queue: AssistantTurnQueue,
  ) => Promise<AssistantReconcileSummary>;
  /** Test seam; production uses `ASSISTANT_RECONCILE_INTERVAL_MS`. */
  readonly reconcileIntervalMs?: number;
  /** Test seam; production uses `ASSISTANT_DRAIN_TIMEOUT_MS`. */
  readonly drainTimeoutMs?: number;
  /** Test seam; production uses `ASSISTANT_LOCK_DURATION_MS`. */
  readonly lockDurationMs?: number;
  /** Test seam; production uses BullMQ's default stalled-check interval. */
  readonly stalledIntervalMs?: number;
}

export interface CreateJobHostOptions {
  readonly redisUrl: string;
  /** Starts the durable assistant queue. Absent: no assistant queue. */
  readonly assistant?: AssistantJobHostOptions;
  readonly logger: Logger;
  readonly workerId: string;
}

type MaintenanceJob = Job<Record<string, never>, number>;

export function createJobHost(options: CreateJobHostOptions): JobHost {
  const connection = new Redis(options.redisUrl, {
    maxRetriesPerRequest: null,
  });
  const assistantConnection =
    options.assistant === undefined
      ? undefined
      : new Redis(options.assistant.redisUrl, { maxRetriesPerRequest: null });

  async function processMaintenanceJob(job: MaintenanceJob): Promise<number> {
    switch (job.name) {
      case ASSISTANT_RECONCILE_JOB_NAME: {
        const reconcile = options.assistant?.reconcile;
        if (reconcile === undefined || assistantQueue === undefined) {
          // A scheduler left behind by a boot that had the assistant mounted.
          options.logger.error(
            { worker_id: options.workerId },
            "assistant reconciler is not mounted here",
          );
          return 0;
        }
        const summary = await reconcile(assistantQueue);
        options.logger.info(
          {
            worker_id: options.workerId,
            listed: summary.listed,
            reenqueued: summary.reenqueued,
            backed_off: summary.backedOff,
            interrupted: summary.interrupted,
            released: summary.released,
            left: summary.left,
            failed: summary.failed,
          },
          "assistant turns reconciled",
        );
        return summary.listed;
      }
      default: {
        options.logger.error(
          {
            worker_id: options.workerId,
            job_name: job.name,
            job_id: job.id,
          },
          "unknown maintenance job",
        );
        return 0;
      }
    }
  }

  /**
   * A job is a pointer to a turn and nothing more. One that is not a turn's
   * identity under the id that identity derives is not a turn's job — BullMQ's
   * one-job-per-id would not hold for it — so it is dropped, never retried.
   */
  async function processAssistantJob(
    job: Job<unknown, string>,
  ): Promise<string> {
    const assistant = options.assistant;
    if (assistant === undefined) {
      throw new CoreInvariantError(
        "assistant queue started without a processor",
      );
    }
    const parsed =
      job.name === ASSISTANT_TURN_JOB_NAME
        ? assistantTurnJobSchema.safeParse(job.data)
        : undefined;
    if (
      parsed?.success !== true ||
      job.id !== assistantTurnJobId(parsed.data)
    ) {
      options.logger.error(
        { worker_id: options.workerId, job_name: job.name },
        "assistant job is not a turn's job and was dropped",
      );
      return "dropped";
    }
    let outcome: AssistantTurnJobOutcome;
    try {
      outcome = await assistant.process(parsed.data);
    } catch (error) {
      // Never rethrown. A thrown job's message becomes its `failedReason` on
      // the queue Redis — in the job and in the queue's event stream, which
      // outlives `removeOnFail` — and a core error's message can name a person
      // and a company, a Postgres error its text (ADR-0039: no personal data on
      // the queue's disk). The redacting process log is where it goes. The job
      // completes, so it is still never run again.
      options.logger.error(
        { err: error, worker_id: options.workerId },
        "assistant job errored",
      );
      return "errored";
    }
    options.logger.info(
      { worker_id: options.workerId, outcome: outcome.kind },
      "assistant job processed",
    );
    return outcome.kind;
  }

  let assistantWorker: Worker<unknown, string> | undefined;
  let assistantQueue: Queue | undefined;
  let queue: Queue | undefined;
  let worker: Worker<Record<string, never>, number> | undefined;
  let started = false;
  let closed = false;
  /** In-flight start, so close() cannot tear down mid-initialization. */
  let starting: Promise<void> | undefined;

  async function startOnce(): Promise<void> {
    await connection.ping();
    queue = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection,
      prefix: BULLMQ_PREFIX,
    });
    worker = new Worker(MAINTENANCE_QUEUE_NAME, processMaintenanceJob, {
      connection,
      prefix: BULLMQ_PREFIX,
      concurrency: 1,
      lockDuration: MAINTENANCE_LOCK_DURATION_MS,
    });
    worker.on("error", (error) => {
      options.logger.error(
        { err: error, worker_id: options.workerId },
        "maintenance worker error",
      );
    });
    worker.on("failed", (job, error) => {
      options.logger.error(
        {
          err: error,
          worker_id: options.workerId,
          job_id: job?.id,
          job_name: job?.name,
        },
        "maintenance job failed",
      );
    });
    // The reconciler's pass is a maintenance job like any other — safe to miss,
    // safe to run again — while the turns it enqueues go on the queue Redis.
    if (options.assistant?.reconcile === undefined) {
      await queue.removeJobScheduler(ASSISTANT_RECONCILE_JOB_NAME);
    } else {
      await queue.upsertJobScheduler(
        ASSISTANT_RECONCILE_JOB_NAME,
        {
          every:
            options.assistant.reconcileIntervalMs ??
            ASSISTANT_RECONCILE_INTERVAL_MS,
        },
        {
          name: ASSISTANT_RECONCILE_JOB_NAME,
          data: {},
          opts: {
            removeOnComplete: true,
            removeOnFail: 50,
          },
        },
      );
    }
    if (options.assistant !== undefined && assistantConnection !== undefined) {
      await assistantConnection.ping();
      assistantQueue = new Queue(ASSISTANT_QUEUE_NAME, {
        connection: assistantConnection,
        prefix: ASSISTANT_QUEUE_PREFIX,
      });
      assistantWorker = new Worker<unknown, string>(
        ASSISTANT_QUEUE_NAME,
        processAssistantJob,
        {
          connection: assistantConnection,
          prefix: ASSISTANT_QUEUE_PREFIX,
          concurrency: ASSISTANT_QUEUE_CONCURRENCY,
          lockDuration:
            options.assistant.lockDurationMs ?? ASSISTANT_LOCK_DURATION_MS,
          maxStalledCount: ASSISTANT_MAX_STALLED_COUNT,
          ...(options.assistant.stalledIntervalMs === undefined
            ? {}
            : { stalledInterval: options.assistant.stalledIntervalMs }),
        },
      );
      assistantWorker.on("error", (error) => {
        options.logger.error(
          { err: error, worker_id: options.workerId },
          "assistant worker error",
        );
      });
      assistantWorker.on("failed", (job, error) => {
        // A stalled job lands here too: failed, removed, never re-run. Its
        // turn stays running until the reconciler passes its deadline.
        options.logger.error(
          { err: error, worker_id: options.workerId, job_name: job?.name },
          "assistant job failed",
        );
      });
      await assistantWorker.waitUntilReady();
    }
    await worker.waitUntilReady();
    started = true;
    options.logger.info(
      {
        worker_id: options.workerId,
        queue: MAINTENANCE_QUEUE_NAME,
        assistant_queue:
          assistantWorker === undefined ? null : ASSISTANT_QUEUE_NAME,
        prefix: BULLMQ_PREFIX,
      },
      "maintenance job host started",
    );
  }

  /**
   * Waits for the turns this worker is running, and no longer than the drain
   * bound. A turn stops itself at its own deadline, so the wait normally ends
   * well inside it; past the bound the process stops waiting rather than
   * refusing to shut down, and the turn's row is left for the reconciler to
   * interrupt — the same recovery a worker that crashed gets.
   */
  async function drainAssistantTurns(
    worker: Worker<unknown, string>,
  ): Promise<void> {
    const timeoutMs =
      options.assistant?.drainTimeoutMs ?? ASSISTANT_DRAIN_TIMEOUT_MS;
    const drained = worker.close();
    let wait: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      drained.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        wait = setTimeout(() => {
          resolve(true);
        }, timeoutMs);
      }),
    ]);
    if (wait !== undefined) {
      clearTimeout(wait);
    }
    if (timedOut) {
      // Never awaited again; BullMQ keeps one close per worker, so it cannot be
      // forced from here, and its rejection must not surface unhandled.
      drained.catch(() => undefined);
      options.logger.warn(
        { worker_id: options.workerId, drain_timeout_ms: timeoutMs },
        "assistant turns still running at the drain timeout",
      );
    }
  }

  return {
    async start() {
      if (started || closed) {
        return;
      }
      starting ??= startOnce();
      await starting;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      if (starting !== undefined) {
        // Wait for an in-flight start so teardown never races registration
        // (queues/workers created after close began would leak). A failed
        // start still leaves partial resources — close them below.
        try {
          await starting;
        } catch {
          // start()'s caller already received the failure.
        }
      }
      // First, and waited for: an in-flight turn finishes before the process
      // goes (ADR-0039 — the stop grace period is a production requirement).
      if (assistantWorker !== undefined) {
        await drainAssistantTurns(assistantWorker);
      }
      if (assistantQueue !== undefined) {
        await assistantQueue.close();
      }
      if (worker !== undefined) {
        await worker.close();
      }
      if (queue !== undefined) {
        await queue.close();
      }
      await connection.quit();
      if (assistantConnection !== undefined) {
        await assistantConnection.quit();
      }
    },
  };
}
