import { CoreInvariantError } from "@showzy/core/errors";
import type { Database } from "@showzy/db";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";

import {
  PGBOSS_SCHEMA,
  pinnedPgBossSchemaVersion,
  pinnedPgBossVersion,
} from "./pgboss-migration.js";

export const pgBossWithoutMigrator = {
  schema: PGBOSS_SCHEMA,
  migrate: false,
  createSchema: false,
} as const;

export async function assertPgBossSchema(db: Database): Promise<void> {
  const boss = new PgBoss({
    ...pgBossWithoutMigrator,
    db: fromDrizzle(db, sql),
    supervise: false,
    schedule: false,
  });
  const installed = await boss.schemaVersion();
  if (installed !== pinnedPgBossSchemaVersion) {
    throw new CoreInvariantError(
      `pgboss schema version ${String(installed)} does not match pg-boss ${pinnedPgBossVersion} (schema version ${String(pinnedPgBossSchemaVersion)}); apply the drizzle-kit migration, never the library migrator`,
    );
  }
}
