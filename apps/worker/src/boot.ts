/**
 * Process boot: load validated config, bind the files object store, open
 * Postgres + Redis, compose the action pipeline and — when the assistant is
 * mounted — the assistant turn processor, start the BullMQ job host, LISTEN
 * on the outbox channel, start the loop.
 */
import { randomUUID } from "node:crypto";

import type { ServerConfig } from "@showzy/config";
import { createDbClient } from "@showzy/db";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  probeFilesObjectStore,
} from "@showzy/files/storage";
import { openJobRunner, type JobRunnerIntervals } from "@showzy/jobs";
import { Redis } from "ioredis";
import type { Logger } from "pino";

import { composeAssistantJobs } from "./assistant-jobs.js";
import { createOutboxListener } from "./listen.js";
import { createOutboxWorker, type WorkerLoop } from "./loop.js";
import { maintenanceHandlers, workerJobs } from "./maintenance.js";
import { createProcessObservability } from "./observability.js";
import { createActionPipeline } from "./pipeline.js";
import { JOB_DRAIN_TIMEOUT_MS } from "./policy.js";
import {
  createRedisConfirmationStore,
  createRedisRateLimitStore,
} from "./stores/redis.js";
import { workerSubscriptions } from "./subscriptions.js";

export interface BootedWorker {
  readonly loop: WorkerLoop;
  /** The single process logger — the entrypoint reuses it (one identity). */
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface BootWorkerOptions {
  readonly logger?: Logger;
  readonly workerId?: string;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly jobIntervals?: JobRunnerIntervals;
}

export async function bootWorker(
  config: ServerConfig,
  options: BootWorkerOptions = {},
): Promise<BootedWorker> {
  // Every acquired resource registers its release; a failing later boot
  // step unwinds in reverse so nothing leaks (SHO-279).
  const releases: (() => Promise<void> | void)[] = [];
  async function unwind(): Promise<void> {
    for (const release of releases.reverse()) {
      try {
        await release();
      } catch {
        // Best-effort teardown of a failed boot — the original boot error
        // is what the caller must see.
      }
    }
  }

  try {
    configureFilesObjectStore(config.s3);
    releases.push(() => {
      closeFilesObjectStore();
    });
    await probeFilesObjectStore();
    const { logger: processLogger, telemetry } = createProcessObservability({
      name: "worker",
      sentryDsn: config.sentry.dsn,
    });
    const logger = options.logger ?? processLogger;
    const db = createDbClient({
      databaseUrl: config.database.url,
      onPoolError: (error) => {
        logger.error({ err: error }, "idle postgres pool client error");
      },
    });
    releases.push(() => db.pool.end());
    const jobRunner = await openJobRunner(
      {
        db: db.db,
        jobs: workerJobs,
        onError: (error) => {
          logger.error({ err: error }, "job runner error");
        },
        ...(options.jobIntervals === undefined
          ? {}
          : { intervals: options.jobIntervals }),
      },
      "worker",
    );
    releases.push(() => jobRunner.close());
    const redis = new Redis(config.redis.url);
    releases.push(async () => {
      await redis.quit();
    });
    await redis.ping();
    const workerId = options.workerId ?? randomUUID();
    const pipeline = createActionPipeline({
      db: db.db,
      logger,
      telemetry,
      jobs: jobRunner.port,
      rateLimitStore: createRedisRateLimitStore(redis),
      confirmationStore: createRedisConfirmationStore(redis),
      ipHmacSecret: config.rateLimit.ipHmacSecret,
    });
    await jobRunner.work({
      deps: pipeline,
      handlers: [
        ...maintenanceHandlers(logger),
        ...composeAssistantJobs({
          ai: config.ai,
          pipeline,
          sharedRedis: redis,
          logger,
        }),
      ],
      drainTimeoutMs: JOB_DRAIN_TIMEOUT_MS,
    });
    const loop = createOutboxWorker({
      db: db.db,
      pipeline,
      subscriptions: workerSubscriptions,
      workerId,
      logger,
      listen: createOutboxListener({
        connectionString: config.database.url,
        logger,
      }),
      ...(options.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.pollIntervalMs }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    releases.push(() => loop.stop());
    await loop.start();
    return {
      loop,
      logger,
      async close() {
        await jobRunner.close();
        await loop.stop();
        closeFilesObjectStore();
        await redis.quit();
        await db.pool.end();
      },
    };
  } catch (error) {
    await unwind();
    throw error;
  }
}
