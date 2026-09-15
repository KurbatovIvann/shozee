import { CoreInvariantError } from "@showzy/core/errors";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  pgBossMaintenanceStampColumns,
  pinnedPgBossSchemaVersion,
} from "./pgboss-migration.js";
import { assertPgBossSchema, pgBossWithoutMigrator } from "./pgboss-schema.js";

let database: TestDatabase;

async function installedVersion(): Promise<number> {
  const result = await database.admin.query<{ version: number }>(
    "SELECT version FROM pgboss.version",
  );
  return result.rows[0]?.version ?? Number.NaN;
}

async function withInstalledVersion(
  version: number,
  body: () => Promise<void>,
): Promise<void> {
  await database.admin.query("UPDATE pgboss.version SET version = $1", [
    version,
  ]);
  try {
    await body();
  } finally {
    await database.admin.query("UPDATE pgboss.version SET version = $1", [
      pinnedPgBossSchemaVersion,
    ]);
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

describe("assertPgBossSchema", () => {
  it("passes on a database migrated by drizzle-kit", async () => {
    await expect(installedVersion()).resolves.toBe(pinnedPgBossSchemaVersion);
    await expect(
      assertPgBossSchema(database.runtime.db),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["older", pinnedPgBossSchemaVersion - 1],
    ["newer", pinnedPgBossSchemaVersion + 1],
  ])(
    "fails on an %s version row and never migrates it",
    async (_label, changed) => {
      await withInstalledVersion(changed, async () => {
        await expect(
          assertPgBossSchema(database.runtime.db),
        ).rejects.toBeInstanceOf(CoreInvariantError);
        await expect(installedVersion()).resolves.toBe(changed);
      });
    },
  );

  it("refuses to start pg-boss on a changed version row with the migrator disabled", async () => {
    await withInstalledVersion(pinnedPgBossSchemaVersion - 1, async () => {
      const boss = new PgBoss({
        ...pgBossWithoutMigrator,
        db: fromDrizzle(database.runtime.db, sql),
        supervise: false,
        schedule: false,
      });
      await expect(boss.start()).rejects.toThrow();
      await expect(installedVersion()).resolves.toBe(
        pinnedPgBossSchemaVersion - 1,
      );
    });
  });
});

describe("showzy_app grants on pgboss", () => {
  it("has no CREATE on the pgboss schema", async () => {
    const result = await database.runtime.pool.query<{ allowed: boolean }>(
      "SELECT has_schema_privilege('pgboss', 'CREATE') AS allowed",
    );
    expect(result.rows[0]?.allowed).toBe(false);
  });

  it("may not insert, delete or change the pgboss version row", async () => {
    const result = await database.runtime.pool.query<{
      canInsert: boolean;
      canDelete: boolean;
      canUpdateVersion: boolean;
    }>(
      `SELECT has_table_privilege('pgboss.version', 'INSERT') AS "canInsert",
              has_table_privilege('pgboss.version', 'DELETE') AS "canDelete",
              has_column_privilege('pgboss.version', 'version', 'UPDATE') AS "canUpdateVersion"`,
    );
    expect(result.rows[0]).toEqual({
      canInsert: false,
      canDelete: false,
      canUpdateVersion: false,
    });
    await expect(
      database.runtime.pool.query("DELETE FROM pgboss.version"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      database.runtime.pool.query("UPDATE pgboss.version SET version = 0"),
    ).rejects.toThrow(/permission denied/);
    await expect(installedVersion()).resolves.toBe(pinnedPgBossSchemaVersion);
  });

  it.each(pgBossMaintenanceStampColumns)(
    "may stamp the %s maintenance column",
    async (column) => {
      const result = await database.runtime.pool.query<{ allowed: boolean }>(
        "SELECT has_column_privilege('pgboss.version', $1, 'UPDATE') AS allowed",
        [column],
      );
      expect(result.rows[0]?.allowed).toBe(true);
    },
  );

  it("runs a supervise and monitor pass as the runtime role", async () => {
    const errors: unknown[] = [];
    const boss = new PgBoss({
      ...pgBossWithoutMigrator,
      db: fromDrizzle(database.runtime.db, sql),
      supervise: false,
      schedule: false,
    });
    boss.on("error", (error) => errors.push(error));
    await boss.start();
    try {
      const queue = "sho-657-supervise";
      await boss.createQueue(queue);
      await boss.send(queue, { probe: true });
      await expect(boss.supervise(queue)).resolves.toBeUndefined();
      const cached = await boss.getQueue(queue);
      expect(cached?.queuedCount).toBe(1);
    } finally {
      await boss.stop({ graceful: false, close: false });
    }
    expect(errors).toEqual([]);
  });

  it("sends, fetches and completes a job as the runtime role", async () => {
    const errors: unknown[] = [];
    const boss = new PgBoss({
      ...pgBossWithoutMigrator,
      db: fromDrizzle(database.runtime.db, sql),
      supervise: false,
      schedule: false,
    });
    boss.on("error", (error) => errors.push(error));
    await boss.start();
    try {
      const queue = "sho-643-grants";
      await boss.createQueue(queue);
      const id = await boss.send(queue, { probe: true });
      expect(id).toEqual(expect.any(String));

      const [job, ...rest] = await boss.fetch<{ probe: boolean }>(queue);
      expect(rest).toHaveLength(0);
      expect(job?.id).toBe(id);
      expect(job?.data).toEqual({ probe: true });

      await boss.complete(queue, job?.id ?? "");
      const [stored] = await boss.findJobs(queue, { id: id ?? "" });
      expect(stored?.state).toBe("completed");
    } finally {
      await boss.stop({ graceful: false, close: false });
    }
    expect(errors).toEqual([]);
  });
});
