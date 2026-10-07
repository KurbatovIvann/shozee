import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { createDbClient } from "../client.js";
import { recordHarnessSetupCount } from "./ci-probe.js";
import type { DbHarnessContext } from "./context.js";

const templateDatabase = "showzy_template";
const runtimeRole = "showzy_test_app";
const sessionIdLabel = "org.testcontainers.session-id";
const migrationsFolder = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

function databaseUrl(
  source: string,
  database: string,
  credentials?: { user: string; password: string },
): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  if (credentials !== undefined) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

function isolateReaperSessionFromOtherRuns(): void {
  process.env["TESTCONTAINERS_RYUK_TEST_LABEL"] = "true";
}

export default async function setup(project: TestProject) {
  recordHarnessSetupCount();
  isolateReaperSessionFromOtherRuns();
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:17-alpine",
  ).start();
  const adminUrl = container.getConnectionUri();
  const control = new pg.Client({
    connectionString: databaseUrl(adminUrl, "postgres"),
  });
  await control.connect();

  try {
    await control.query(`CREATE DATABASE "${templateDatabase}"`);
    const template = createDbClient({
      databaseUrl: databaseUrl(adminUrl, templateDatabase),
    });
    try {
      await migrate(template.db, { migrationsFolder });
    } finally {
      await template.pool.end();
    }

    const runtimePassword = randomUUID();
    // Per-run LOGIN password for the template-DB app role. Distinct from
    // migration-role NOLOGIN (0001 never embeds a password) and from the
    // Testcontainers/compose superuser URL. Not stored in the repo.
    await control.query(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}' IN ROLE showzy_app`,
    );
    await control.query(
      `ALTER DATABASE "${templateDatabase}" IS_TEMPLATE TRUE`,
    );

    const reaperSessionId = container.getLabels()[sessionIdLabel];
    if (reaperSessionId === undefined) {
      throw new Error(
        `harness container is missing the ${sessionIdLabel} label`,
      );
    }

    const context: DbHarnessContext = {
      adminUrl,
      templateDatabase,
      runtimeRole,
      runtimePassword,
      reaperSessionId,
    };
    project.provide("dbHarness", context);
  } catch (error) {
    await container.stop();
    throw error;
  } finally {
    await control.end();
  }

  let stopped = false;
  const teardown = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await container.stop();
  };
  process.once("SIGINT", () => {
    void teardown();
  });
  process.once("SIGTERM", () => {
    void teardown();
  });

  return teardown;
}
