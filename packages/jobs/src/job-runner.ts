import type { Job, JobPort } from "@showzy/core";
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

export type JobRunnerRole = "api" | "worker";

export interface JobRunnerConfig {
  readonly db: Database;
  readonly jobs: readonly Job[];
  readonly onError: (error: Error) => void;
}

export interface JobRunner {
  readonly port: JobPort;
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
  });
  boss.on("error", config.onError);
  const declarations = queueDeclarations(config.jobs);
  if (worker) {
    await provisionQueues(boss, declarations);
  }
  await assertQueuesMatchDeclarations(boss, declarations);
  await boss.start();
  return {
    port: createPgBossJobPort(boss),
    async close() {
      await boss.stop({ close: false });
    },
  };
}
