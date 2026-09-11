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
import { Redis } from "ioredis";
import type { Logger } from "pino";

import { composeAssistantTurns } from "./assistant.js";
import { createJobHost, type JobHost } from "./jobs.js";
import { createOutboxListener } from "./listen.js";
import { createOutboxWorker, type WorkerLoop } from "./loop.js";
import { createProcessObservability } from "./observability.js";
import { createActionPipeline } from "./pipeline.js";
import {
  createRedisConfirmationStore,
  createRedisRateLimitStore,
} from "./stores/redis.js";
import { workerSubscriptions } from "./subscriptions.js";

export interface BootedWorker {
  readonly loop: WorkerLoop;
  readonly jobs: JobHost;
  /** The single process logger — the entrypoint reuses it (one identity). */
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface BootWorkerOptions {
  readonly logger?: Logger;
  readonly workerId?: string;
  readonly pollIntervalMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly sweepIntervalMs?: number;
  readonly backfillIntervalMs?: number;
  readonly now?: () => number;
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
      rateLimitStore: createRedisRateLimitStore(redis),
      confirmationStore: createRedisConfirmationStore(redis),
      ipHmacSecret: config.rateLimit.ipHmacSecret,
    });
    // Mounted on the API's rule. The turn's pauses, budget and events use the
    // shared Redis; only the queue is on the queue Redis (ADR-0039).
    const assistantTurns = composeAssistantTurns({
      ai: config.ai,
      pipeline,
      sharedRedis: redis,
      logger,
    });
    const jobHostOptions = {
      redisUrl: config.redis.url,
      db: db.db,
      logger,
      workerId,
      pipeline,
      ...(assistantTurns !== undefined
        ? {
            assistant: {
              redisUrl: config.queueRedis.url,
              process: assistantTurns,
            },
          }
        : {}),
      ...(options.cleanupIntervalMs !== undefined
        ? { cleanupIntervalMs: options.cleanupIntervalMs }
        : {}),
      ...(options.sweepIntervalMs !== undefined
        ? { sweepIntervalMs: options.sweepIntervalMs }
        : {}),
      ...(options.backfillIntervalMs !== undefined
        ? { backfillIntervalMs: options.backfillIntervalMs }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
    const jobs = createJobHost(jobHostOptions);
    releases.push(() => jobs.close());
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
    await jobs.start();
    await loop.start();
    return {
      loop,
      jobs,
      logger,
      async close() {
        await jobs.close();
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
