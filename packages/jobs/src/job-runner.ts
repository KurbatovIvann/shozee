import type { Job, JobPort } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Database } from "@showzy/db";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

import { createPgBossJobPort } from "./pgboss-job-port.js";
import { assertPgBossSchema, pgBossWithoutMigrator } from "./pgboss-schema.js";
import {
  assertQueuesMatchDeclarations,
  provisionQueues,
  queueDeclarations,
} from "./queue-provisioning.js";
import {
  createJobWorker,
  type JobWorker,
  type JobWorkerOptions,
} from "./worker-host.js";

export type JobRunnerRole = "api" | "worker";

export interface JobRunnerIntervals {
  readonly pollingSeconds: number;
  readonly superviseSeconds: number;
  readonly cronSeconds: number;
}

export interface JobRunnerConfig {
  readonly db: Database;
  readonly jobs: readonly Job[];
  readonly onError: (error: Error) => void;
  readonly intervals?: JobRunnerIntervals;
}

export interface JobRunner {
  readonly port: JobPort;
  work(options: JobWorkerOptions): Promise<void>;
  close(): Promise<void>;
}

export async function openJobRunner(
  config: JobRunnerConfig,
  role: JobRunnerRole,
): Promise<JobRunner> {
  await assertPgBossSchema(config.db);
  const worker = role === "worker";
  const boss = new PgBoss({
    ...pgBossWithoutMigrator,
    db: fromDrizzle(config.db, sql),
    useListenNotify: false,
    supervise: worker,
    schedule: worker,
    ...libraryIntervals(config.intervals),
  });
  boss.on("error", config.onError);
  const declarations = queueDeclarations(config.jobs);
  if (worker) {
    await provisionQueues(boss, declarations);
  }
  await assertQueuesMatchDeclarations(boss, declarations);
  await boss.start();
  let jobWorker: JobWorker | undefined;
  return {
    port: createPgBossJobPort(boss),
    async work(options) {
      if (!worker) {
        throw new CoreInvariantError(
          "an api job runner only sends; the worker role works jobs",
        );
      }
      if (jobWorker !== undefined) {
        throw new CoreInvariantError(
          "this job runner already began registering its handlers, even if that start failed; close it instead of calling work again",
        );
      }
      jobWorker = createJobWorker(
        boss,
        config.jobs,
        options,
        config.intervals?.pollingSeconds,
      );
      await jobWorker.start();
    },
    async close() {
      await (jobWorker?.drain() ?? boss.stop({ close: false }));
    },
  };
}

function libraryIntervals(intervals: JobRunnerIntervals | undefined) {
  if (intervals === undefined) {
    return {};
  }
  return {
    superviseIntervalSeconds: intervals.superviseSeconds,
    monitorIntervalSeconds: intervals.superviseSeconds,
    maintenanceIntervalSeconds: intervals.superviseSeconds,
    cronMonitorIntervalSeconds: intervals.cronSeconds,
    cronWorkerIntervalSeconds: intervals.cronSeconds,
  };
}
