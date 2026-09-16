import { randomUUID } from "node:crypto";

import type { ServerConfig } from "@showzy/config";
import { createDbClient, type DbClient } from "@showzy/db";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  probeFilesObjectStore,
} from "@showzy/files/storage";
import {
  openJobRunner,
  type JobRunner,
  type JobRunnerIntervals,
} from "@showzy/jobs";
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

interface AcquiredWorkerResources {
  objectStore: boolean;
  db?: DbClient;
  jobRunner?: JobRunner;
  redis?: Redis;
  loop?: WorkerLoop;
}

async function releaseInDependencyOrder(
  acquired: AcquiredWorkerResources,
): Promise<readonly unknown[]> {
  const { objectStore, db, jobRunner, redis, loop } = acquired;
  const releases: readonly (() => unknown)[] = [
    () => jobRunner?.close(),
    () => loop?.stop(),
    () => {
      if (objectStore) {
        closeFilesObjectStore();
      }
    },
    () => redis?.quit(),
    () => db?.pool.end(),
  ];
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function bootWorker(
  config: ServerConfig,
  options: BootWorkerOptions = {},
): Promise<BootedWorker> {
  const acquired: AcquiredWorkerResources = { objectStore: false };

  try {
    configureFilesObjectStore(config.s3);
    acquired.objectStore = true;
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
    acquired.db = db;
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
    acquired.jobRunner = jobRunner;
    const redis = new Redis(config.redis.url);
    acquired.redis = redis;
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
    acquired.loop = loop;
    await loop.start();
    return {
      loop,
      logger,
      async close() {
        const failures = await releaseInDependencyOrder(acquired);
        if (failures.length > 0) {
          throw failures[0];
        }
      },
    };
  } catch (error) {
    await releaseInDependencyOrder(acquired);
    throw error;
  }
}
