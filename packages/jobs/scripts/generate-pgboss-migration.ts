import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  PGBOSS_MIGRATION_NAME,
  pgBossMigrationSql,
} from "../src/pgboss-migration.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const migrationFile = new RegExp(`^\\d{4}_${PGBOSS_MIGRATION_NAME}\\.sql$`);

function findMigrations(): string[] {
  return readdirSync(migrationsDir).filter((name) => migrationFile.test(name));
}

if (findMigrations().length === 0) {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@showzy/db",
      "exec",
      "drizzle-kit",
      "generate",
      "--custom",
      `--name=${PGBOSS_MIGRATION_NAME}`,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
}

const [target, ...extra] = findMigrations();
if (target === undefined || extra.length > 0) {
  process.exitCode = 1;
  process.stderr.write(
    `expected exactly one *_${PGBOSS_MIGRATION_NAME}.sql in ${migrationsDir}\n`,
  );
} else {
  writeFileSync(path.join(migrationsDir, target), pgBossMigrationSql());
  process.stdout.write(`wrote ${target}\n`);
}
