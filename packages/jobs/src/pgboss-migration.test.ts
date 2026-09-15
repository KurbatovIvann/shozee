import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PGBOSS_MIGRATION_NAME,
  pgBossMigrationSql,
  pinnedPgBossSchemaVersion,
  pinnedPgBossVersion,
} from "./pgboss-migration.js";
import { pgBossWithoutMigrator } from "./pgboss-schema.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");

function committedPgBossMigrations(): string[] {
  return readdirSync(migrationsDir).filter((name) =>
    new RegExp(`^\\d{4}_${PGBOSS_MIGRATION_NAME}\\.sql$`).test(name),
  );
}

describe("pgboss migration", () => {
  it("pins pg-boss 12.31.0 at schema version 41", () => {
    expect(pinnedPgBossVersion).toBe("12.31.0");
    expect(pinnedPgBossSchemaVersion).toBe(41);
  });

  it("regenerates the committed SQL byte for byte from the installed library", () => {
    const files = committedPgBossMigrations();
    expect(files).toHaveLength(1);
    const committed = readFileSync(
      path.join(migrationsDir, files[0] ?? ""),
      "utf8",
    );
    expect(committed).toBe(pgBossMigrationSql());
  });

  it("is registered in the drizzle-kit journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tag = committedPgBossMigrations()[0]?.replace(/\.sql$/, "");
    expect(journal.entries.map((entry) => entry.tag)).toContain(tag);
  });

  it("runs inside the migrator's transaction instead of its own", () => {
    const sqlText = pgBossMigrationSql();
    expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
    expect(sqlText).toContain(
      `INSERT INTO pgboss.version(version) VALUES ('${String(pinnedPgBossSchemaVersion)}')`,
    );
  });

  it("leaves no library lock or timeout setting in the migrator's transaction", () => {
    const sqlText = pgBossMigrationSql();
    expect(sqlText).not.toMatch(/^\s*SET LOCAL/m);
    expect(sqlText).not.toMatch(/^\s*SELECT pg_advisory_xact_lock/m);
    expect(sqlText).toMatch(/^CREATE SCHEMA IF NOT EXISTS pgboss;$/m);
  });

  it("keeps the version row out of reach of showzy_app except its maintenance stamps", () => {
    const sqlText = pgBossMigrationSql();
    const grant = sqlText.indexOf(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO showzy_app;",
    );
    const revoke = sqlText.indexOf(
      "REVOKE INSERT, UPDATE, DELETE ON pgboss.version FROM showzy_app;",
    );
    const stamps = sqlText.indexOf(
      "GRANT UPDATE (cron_on, bam_on, flow_on, reindex_on, monitor_backoff_on) ON pgboss.version TO showzy_app;",
    );
    expect(grant).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(grant);
    expect(stamps).toBeGreaterThan(revoke);
  });

  it("builds every pg-boss instance without the migrator or persisted queue stats", () => {
    expect(pgBossWithoutMigrator).toEqual({
      schema: "pgboss",
      migrate: false,
      createSchema: false,
      persistQueueStats: false,
    });
  });

  it("grants showzy_app DML on pgboss and nothing that creates objects", () => {
    const sqlText = pgBossMigrationSql();
    expect(sqlText).toContain("GRANT USAGE ON SCHEMA pgboss TO showzy_app;");
    expect(sqlText).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO showzy_app;",
    );
    expect(sqlText).not.toMatch(
      /GRANT[^;]*(CREATE|TRUNCATE|ALL PRIVILEGES)[^;]*showzy_app/,
    );
  });
});
