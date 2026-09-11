/**
 * BullMQ job host (fnd-T29, ADR-0007 / SHO-120 / SHO-236 / SHO-248). One
 * dedicated Redis connection (`maxRetriesPerRequest: null`), prefix
 * `showzy`, queues `maintenance` and `pdf`. Processors stay thin:
 * idempotency cleanup calls the core library; abandoned-upload GC,
 * catalog rendition backfill, and PDF render invoke registered system
 * actions. Domain event delivery stays on the outbox loop (ADR-0012).
 *
 * The `assistant` queue (ADR-0039, SHO-569) is the one durable queue, on its
 * own connection to the queue Redis, and is started only when a processor is
 * given. The host parses a job into a turn's identity and hands it to
 * `createAssistantTurnProcessor`; the turn is the processor's work.
 */
import { randomUUID } from "node:crypto";

import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  ASSISTANT_TURN_JOB_NAME,
  assistantTurnJobId,
  assistantTurnJobSchema,
  type AssistantTurnJob,
  type AssistantTurnJobOutcome,
} from "@showzy/assistant-runtime";
import {
  cleanupExpiredIdempotencyKeys,
  executeAction,
  type ActionPipelineDeps,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Database } from "@showzy/db";
import { renderPdf } from "@showzy/doc-generation";
import {
  backfillCatalogRenditions,
  sweepAbandonedUploads,
} from "@showzy/files";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";

import {
  ASSISTANT_LOCK_DURATION_MS,
  ASSISTANT_MAX_STALLED_COUNT,
  ASSISTANT_QUEUE_CONCURRENCY,
  BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS,
  BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
  BULLMQ_PREFIX,
  CLEANUP_INTERVAL_MS,
  IDEMPOTENCY_CLEANUP_JOB_NAME,
  MAINTENANCE_LOCK_DURATION_MS,
  MAINTENANCE_QUEUE_NAME,
  MAINTENANCE_SERVICE_NAME,
  PDF_JOB_NAME,
  PDF_LOCK_DURATION_MS,
  PDF_QUEUE_NAME,
  PDF_SERVICE_NAME,
  SWEEP_ABANDONED_UPLOADS_JOB_NAME,
  SWEEP_INTERVAL_MS,
} from "./policy.js";

export interface SweepTickResult {
  readonly leftoverStagingDeleted: number;
  readonly abandonedPendingDeleted: number;
}

export interface BackfillTickResult {
  readonly filled: number;
  readonly alreadyComplete: number;
  readonly skippedMissingOriginal: number;
  readonly skippedUndecodable: number;
}

export interface JobHost {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface AssistantJobHostOptions {
  /** The queue Redis (`config.queueRedis.url`), never the shared one. */
  readonly redisUrl: string;
  /** `createAssistantTurnProcessor` from `@showzy/assistant-runtime`. */
  readonly process: (job: AssistantTurnJob) => Promise<AssistantTurnJobOutcome>;
  /** Test seam; production uses `ASSISTANT_LOCK_DURATION_MS`. */
  readonly lockDurationMs?: number;
  /** Test seam; production uses BullMQ's default stalled-check interval. */
  readonly stalledIntervalMs?: number;
}

export interface CreateJobHostOptions {
  readonly redisUrl: string;
  /** Starts the durable assistant queue. Absent: no assistant queue. */
  readonly assistant?: AssistantJobHostOptions;
  readonly db: Database;
  readonly logger: Logger;
  readonly workerId: string;
  readonly cleanupIntervalMs?: number;
  readonly sweepIntervalMs?: number;
  readonly backfillIntervalMs?: number;
  readonly now?: () => number;
  /**
   * Required for the default sweep path (`files.sweepAbandonedUploads`),
   * catalog rendition backfill (`files.backfillCatalogRenditions`),
   * and the pdf processor (`docGeneration.renderPdf`). Tests that stub
   * `sweep` / `backfill` and never enqueue pdf jobs may omit it.
   */
  readonly pipeline?: ActionPipelineDeps;
  /** Test seam to observe or gate a tick; production omits this. */
  cleanup?: () => Promise<number>;
  /** Test seam to observe or gate a sweep tick; production omits this. */
  sweep?: () => Promise<SweepTickResult>;
  /** Test seam to observe or gate a backfill tick; production omits this. */
  backfill?: () => Promise<BackfillTickResult>;
}

type MaintenanceJob = Job<Record<string, never>, number>;
type PdfJob = Job<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createJobHost(options: CreateJobHostOptions): JobHost {
  const connection = new Redis(options.redisUrl, {
    maxRetriesPerRequest: null,
  });
  // Its own connection: the assistant queue lives on the persistent queue
  // Redis, and the maintenance and pdf queues stay on the shared one.
  const assistantConnection =
    options.assistant === undefined
      ? undefined
      : new Redis(options.assistant.redisUrl, { maxRetriesPerRequest: null });
  const cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const backfillIntervalMs =
    options.backfillIntervalMs ?? BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS;
  const runCleanup =
    options.cleanup ??
    (() =>
      options.now === undefined
        ? cleanupExpiredIdempotencyKeys(options.db)
        : cleanupExpiredIdempotencyKeys(options.db, options.now));

  async function runSweep(job: MaintenanceJob): Promise<SweepTickResult> {
    if (options.sweep !== undefined) {
      return options.sweep();
    }
    if (options.pipeline === undefined) {
      throw new CoreInvariantError(
        "files.sweepAbandonedUploads requires the worker action pipeline",
      );
    }
    return executeAction(options.pipeline, {
      action: sweepAbandonedUploads,
      input: {},
      request: {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        channel: "system",
        idempotencyKey: job.id ?? randomUUID(),
      },
      principal: {
        mode: "system",
        serviceName: MAINTENANCE_SERVICE_NAME,
        scope: { scope: "global" },
      },
    });
  }

  async function runBackfill(job: MaintenanceJob): Promise<BackfillTickResult> {
    if (options.backfill !== undefined) {
      return options.backfill();
    }
    if (options.pipeline === undefined) {
      throw new CoreInvariantError(
        "files.backfillCatalogRenditions requires the worker action pipeline",
      );
    }
    return executeAction(options.pipeline, {
      action: backfillCatalogRenditions,
      input: {},
      request: {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        channel: "system",
        idempotencyKey: job.id ?? randomUUID(),
      },
      principal: {
        mode: "system",
        serviceName: MAINTENANCE_SERVICE_NAME,
        scope: { scope: "global" },
      },
    });
  }

  async function processMaintenanceJob(job: MaintenanceJob): Promise<number> {
    switch (job.name) {
      case IDEMPOTENCY_CLEANUP_JOB_NAME: {
        const removed = await runCleanup();
        if (removed > 0) {
          options.logger.info(
            { worker_id: options.workerId, removed_keys: removed },
            "expired idempotency keys cleaned",
          );
        }
        return removed;
      }
      case SWEEP_ABANDONED_UPLOADS_JOB_NAME: {
        const swept = await runSweep(job);
        options.logger.info(
          {
            worker_id: options.workerId,
            leftover_staging_deleted: swept.leftoverStagingDeleted,
            abandoned_pending_deleted: swept.abandonedPendingDeleted,
          },
          "abandoned uploads swept",
        );
        return swept.leftoverStagingDeleted + swept.abandonedPendingDeleted;
      }
      case BACKFILL_CATALOG_RENDITIONS_JOB_NAME: {
        const backfilled = await runBackfill(job);
        options.logger.info(
          {
            worker_id: options.workerId,
            filled: backfilled.filled,
            already_complete: backfilled.alreadyComplete,
            skipped_missing_original: backfilled.skippedMissingOriginal,
            skipped_undecodable: backfilled.skippedUndecodable,
          },
          "catalog renditions backfilled",
        );
        return (
          backfilled.filled +
          backfilled.skippedMissingOriginal +
          backfilled.skippedUndecodable
        );
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
   * Thin `executeAction(renderPdf)` wrapper. Retryable failures throw so
   * the job is not completed; the outbox is the production retry budget.
   */
  async function processPdfJob(job: PdfJob): Promise<unknown> {
    if (job.name !== PDF_JOB_NAME) {
      options.logger.error(
        {
          worker_id: options.workerId,
          job_name: job.name,
          job_id: job.id,
        },
        "unknown pdf job",
      );
      return {};
    }
    if (options.pipeline === undefined) {
      throw new CoreInvariantError(
        "docGeneration.renderPdf requires the worker action pipeline",
      );
    }
    const data = isRecord(job.data) ? job.data : {};
    const companyId = readNonEmptyString(data, "companyId");
    if (companyId === undefined) {
      throw new CoreInvariantError("pdf job is missing tenant companyId");
    }
    return executeAction(options.pipeline, {
      action: renderPdf,
      input: job.data,
      request: {
        requestId: readNonEmptyString(data, "requestId") ?? randomUUID(),
        correlationId:
          readNonEmptyString(data, "correlationId") ?? randomUUID(),
        channel: "system",
        idempotencyKey: job.id ?? randomUUID(),
      },
      principal: {
        mode: "system",
        serviceName: PDF_SERVICE_NAME,
        scope: { scope: "tenant", companyId },
      },
    });
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
  let queue: Queue | undefined;
  let worker: Worker<Record<string, never>, number> | undefined;
  let pdfQueue: Queue | undefined;
  let pdfWorker: Worker<Record<string, unknown>> | undefined;
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
    pdfQueue = new Queue(PDF_QUEUE_NAME, {
      connection,
      prefix: BULLMQ_PREFIX,
    });
    pdfWorker = new Worker(PDF_QUEUE_NAME, processPdfJob, {
      connection,
      prefix: BULLMQ_PREFIX,
      concurrency: 1,
      lockDuration: PDF_LOCK_DURATION_MS,
    });
    pdfWorker.on("error", (error) => {
      options.logger.error(
        { err: error, worker_id: options.workerId },
        "pdf worker error",
      );
    });
    pdfWorker.on("failed", (job, error) => {
      options.logger.error(
        {
          err: error,
          worker_id: options.workerId,
          job_id: job?.id,
          job_name: job?.name,
        },
        "pdf job failed",
      );
    });
    await queue.upsertJobScheduler(
      IDEMPOTENCY_CLEANUP_JOB_NAME,
      { every: cleanupIntervalMs },
      {
        name: IDEMPOTENCY_CLEANUP_JOB_NAME,
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
        },
      },
    );
    await queue.upsertJobScheduler(
      SWEEP_ABANDONED_UPLOADS_JOB_NAME,
      { every: sweepIntervalMs },
      {
        name: SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
        },
      },
    );
    await queue.upsertJobScheduler(
      BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
      { every: backfillIntervalMs },
      {
        name: BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
        },
      },
    );
    if (options.assistant !== undefined && assistantConnection !== undefined) {
      await assistantConnection.ping();
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
    await pdfWorker.waitUntilReady();
    started = true;
    options.logger.info(
      {
        worker_id: options.workerId,
        queue: MAINTENANCE_QUEUE_NAME,
        pdf_queue: PDF_QUEUE_NAME,
        assistant_queue:
          assistantWorker === undefined ? null : ASSISTANT_QUEUE_NAME,
        prefix: BULLMQ_PREFIX,
        cleanup_interval_ms: cleanupIntervalMs,
        sweep_interval_ms: sweepIntervalMs,
        backfill_interval_ms: backfillIntervalMs,
      },
      "maintenance job host started",
    );
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
        await assistantWorker.close();
      }
      if (pdfWorker !== undefined) {
        await pdfWorker.close();
      }
      if (worker !== undefined) {
        await worker.close();
      }
      if (pdfQueue !== undefined) {
        await pdfQueue.close();
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
