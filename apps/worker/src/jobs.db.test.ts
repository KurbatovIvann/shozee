import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  AI_BUDGET_TTL_SEC,
  aiBudgetHoldKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  assistantSweepOverdueTurnsJob,
  assistantTurnJob,
  createRedisAiBudgetStore,
} from "@showzy/assistant-runtime";
import { createProcessLogger, loadServerConfig } from "@showzy/config";
import {
  defineJob,
  executeAction,
  type ImplementedAction,
  type Job,
} from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import {
  buildJobEnvelope,
  createTestKit,
  crossTenantSuite,
  isolationCase,
  jobIsolationCase,
  jobIsolationSuite,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, idempotencyKeys } from "@showzy/db";
import {
  assistantChatMessages,
  assistantConversations,
  assistantTurns,
} from "@showzy/db/schema/assistant";
import {
  backfillCatalogRenditions,
  backfillCatalogRenditionsJob,
  sweepAbandonedUploads,
  sweepAbandonedUploadsJob,
} from "@showzy/files";
import {
  configureFilesObjectStore,
  probeFilesObjectStore,
} from "@showzy/files/storage";
import {
  exhaustedQueueName,
  openJobRunner,
  type JobHandler,
  type JobRunner,
} from "@showzy/jobs";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { and, eq, gte, inArray } from "drizzle-orm";
import { Redis } from "ioredis";
import { pino } from "pino";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { bootWorker } from "./boot.js";
import {
  cleanupIdempotencyKeys,
  cleanupIdempotencyKeysJob,
  maintenanceHandler,
  workerJobs,
} from "./maintenance.js";

const silent = pino({ enabled: false });
const REDIS_PASSWORD = "REDIS_TICK_SECRET";

const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const GARAGE_BUCKET = "showzy";
const GARAGE_ACCESS_KEY = "showzy-local";
const GARAGE_SECRET_KEY = "showzy-local-secret";

const MAINTENANCE_JOB_NAMES = [
  sweepAbandonedUploadsJob.name,
  backfillCatalogRenditionsJob.name,
  cleanupIdempotencyKeysJob.name,
];

let kit: TestKit;
let redisContainer: StartedRedisContainer;
let redisUrl: string;
let garage: StartedTestContainer;
let garageEndpoint: string;

beforeAll(async () => {
  kit = await createTestKit();
  redisContainer = await new RedisContainer("redis:8-alpine")
    .withPassword(REDIS_PASSWORD)
    .start();
  redisUrl = redisContainer.getConnectionUrl();

  const garageToml = readFileSync(
    path.join(repoRoot(), "docker/garage/garage.toml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  garage = await new GenericContainer(GARAGE_IMAGE)
    .withCommand(["/garage", "server", "--single-node", "--default-bucket"])
    .withEnvironment({
      GARAGE_ALLOW_WORLD_READABLE_SECRETS: "true",
      GARAGE_DEFAULT_ACCESS_KEY: GARAGE_ACCESS_KEY,
      GARAGE_DEFAULT_SECRET_KEY: GARAGE_SECRET_KEY,
      GARAGE_DEFAULT_BUCKET: GARAGE_BUCKET,
    })
    .withCopyContentToContainer([
      {
        content: garageToml,
        target: "/etc/garage.toml",
      },
    ])
    .withTmpFs({
      "/var/lib/garage/meta": "rw,noexec,nosuid,size=64m",
      "/var/lib/garage/data": "rw,noexec,nosuid,size=256m",
    })
    .withExposedPorts(3900)
    .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/))
    .withStartupTimeout(120_000)
    .start();
  garageEndpoint = `http://127.0.0.1:${String(garage.getMappedPort(3900))}`;
  configureFilesObjectStore(garageS3Config());
  await waitForBucket();
});

afterAll(async () => {
  await kit.db.close();
  await redisContainer.stop();
  await garage.stop();
});

beforeEach(async () => {
  const admin = new Redis(redisUrl);
  await admin.flushdb();
  await admin.quit();
  configureFilesObjectStore(garageS3Config());
});

function repoRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("repository root not found");
    }
    directory = parent;
  }
  return directory;
}

function garageS3Config() {
  return {
    endpoint: garageEndpoint,
    region: "us-east-1",
    accessKeyId: GARAGE_ACCESS_KEY,
    secretAccessKey: GARAGE_SECRET_KEY,
    forcePathStyle: true,
    bucket: GARAGE_BUCKET,
  };
}

async function waitForBucket(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await probeFilesObjectStore();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("Garage bucket did not become ready");
}

function runtimeConnectionString(): string {
  const connectionString = kit.db.runtime.pool.options.connectionString;
  if (connectionString === undefined || connectionString === "") {
    throw new Error("runtime pool is missing a connection string");
  }
  return connectionString;
}

function testEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: runtimeConnectionString(),
    REDIS_URL: redisUrl,
    S3_ENDPOINT: garageEndpoint,
    S3_ACCESS_KEY_ID: GARAGE_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: GARAGE_SECRET_KEY,
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: GARAGE_BUCKET,
    BETTER_AUTH_SECRET: "dev-only-secret-change-me-0000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    IP_HMAC_SECRET: "dev-only-ip-hmac-secret-change-me-00",
  };
}

function testConfig() {
  return loadServerConfig(testEnv());
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for job-host condition");
    }
    await delay(25);
  }
}

async function insertKeyPair(): Promise<{
  expiredKey: string;
  liveKey: string;
}> {
  const expiredKey = randomUUID();
  const liveKey = randomUUID();
  const nowMs = Date.now();
  const action = `workerJobs.cleanup.${randomUUID()}`;
  const row = {
    principalKey: `staff:${kit.identities.users.anna}`,
    scopeKey: `company:${kit.identities.companies.a}`,
    companyId: kit.identities.companies.a,
    action,
    status: "completed" as const,
  };
  await kit.db.runtime.db.insert(idempotencyKeys).values([
    {
      ...row,
      key: expiredKey,
      requestHash: "c".repeat(64),
      attemptId: randomUUID(),
      leaseExpiresAt: new Date(nowMs),
      expiresAt: new Date(nowMs - 1_000),
    },
    {
      ...row,
      key: liveKey,
      requestHash: "d".repeat(64),
      attemptId: randomUUID(),
      leaseExpiresAt: new Date(nowMs + 30_000),
      expiresAt: new Date(nowMs + 48 * 3_600_000),
    },
  ]);
  return { expiredKey, liveKey };
}

async function remainingKeys(
  keys: readonly string[],
): Promise<readonly string[]> {
  const rows = await kit.db.runtime.db
    .select({ key: idempotencyKeys.key })
    .from(idempotencyKeys)
    .where(inArray(idempotencyKeys.key, [...keys]));
  return rows.map((row) => row.key);
}

describe("worker.cleanupIdempotencyKeys", () => {
  let pair = { expiredKey: "", liveKey: "" };

  beforeEach(async () => {
    pair = await insertKeyPair();
  });

  crossTenantSuite(
    () => kit,
    [isolationCase(cleanupIdempotencyKeys, { input: {} }, { input: {} })],
  );

  jobIsolationSuite(
    () => kit,
    [
      jobIsolationCase(
        cleanupIdempotencyKeysJob,
        cleanupIdempotencyKeys,
        { payload: {} },
        undefined,
        async () => {
          expect(await remainingKeys([pair.expiredKey, pair.liveKey])).toEqual([
            pair.liveKey,
          ]);
        },
      ),
    ],
  );

  it("deletes only expired idempotency keys and reports how many", async () => {
    const output = await kit.invoke(cleanupIdempotencyKeys, {});

    expect(output.removed).toBeGreaterThanOrEqual(1);
    expect(await remainingKeys([pair.expiredKey, pair.liveKey])).toEqual([
      pair.liveKey,
    ]);
  });

  it("refuses a tenant-scoped system call and a staff call without deleting any key", async () => {
    await expect(
      executeAction(kit.pipeline, {
        action: cleanupIdempotencyKeys,
        input: {},
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "system",
        },
        principal: {
          mode: "system",
          serviceName: "test.cleanup",
          scope: { scope: "tenant", companyId: kit.identities.companies.a },
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(
      executeAction(kit.pipeline, {
        action: cleanupIdempotencyKeys,
        input: {},
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        principal: {
          mode: "staff",
          session: { userId: kit.identities.users.anna },
          companySelector: kit.identities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(
      [...(await remainingKeys([pair.expiredKey, pair.liveKey]))].sort(),
    ).toEqual([pair.expiredKey, pair.liveKey].sort());
  });

  it("rejects a payload with unknown fields as VALIDATION without deleting any key", async () => {
    await expect(
      kit.invoke(cleanupIdempotencyKeys, { olderThanDays: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(
      [...(await remainingKeys([pair.expiredKey, pair.liveKey]))].sort(),
    ).toEqual([pair.expiredKey, pair.liveKey].sort());
  });
});

describe("apps/worker maintenance jobs on pg-boss (SHO-650)", () => {
  async function schedules(): Promise<{ name: string; cron: string }[]> {
    const result = await kit.db.admin.query<{ name: string; cron: string }>(
      "SELECT name, cron FROM pgboss.schedule WHERE name = ANY($1) ORDER BY name",
      [MAINTENANCE_JOB_NAMES],
    );
    return result.rows;
  }

  it("two booted workers provision each maintenance queue and schedule once", async () => {
    const first = await bootWorker(testConfig(), {
      logger: silent,
      pollIntervalMs: 60_000,
    });
    const second = await bootWorker(testConfig(), {
      logger: silent,
      pollIntervalMs: 60_000,
    });
    try {
      expect(await schedules()).toEqual(
        [
          sweepAbandonedUploadsJob,
          backfillCatalogRenditionsJob,
          cleanupIdempotencyKeysJob,
        ]
          .map(({ name, cron }) => ({ name, cron }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      );
      const queues = await kit.db.admin.query<{ name: string }>(
        "SELECT name FROM pgboss.queue WHERE name = ANY($1)",
        [MAINTENANCE_JOB_NAMES],
      );
      expect(queues.rows.map(({ name }) => name).toSorted()).toEqual(
        [...MAINTENANCE_JOB_NAMES].toSorted(),
      );
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("one tick runs each maintenance action once across two workers", async () => {
    const everyMinute = (job: Job) => defineJob({ ...job, cron: "* * * * *" });
    const jobs: readonly [Job, ImplementedAction][] = [
      [everyMinute(sweepAbandonedUploadsJob), sweepAbandonedUploads],
      [everyMinute(backfillCatalogRenditionsJob), backfillCatalogRenditions],
      [everyMinute(cleanupIdempotencyKeysJob), cleanupIdempotencyKeys],
    ];
    const { expiredKey, liveKey } = await insertKeyPair();
    const startedAt = await kit.db.admin.query<{ now: Date }>(
      "SELECT now() AS now",
    );
    const since = startedAt.rows[0]?.now ?? new Date(0);
    const runs = new Map<string, string[]>(
      MAINTENANCE_JOB_NAMES.map((name) => [name, []]),
    );
    const handlers: JobHandler[] = jobs.map(([job, action]) => {
      const bound = maintenanceHandler(job, action, silent);
      return {
        job,
        async handle(attempt) {
          runs.get(job.name)?.push(attempt.envelope.id);
          await bound.handle(attempt);
        },
      };
    });
    const runners: JobRunner[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const runner = await openJobRunner(
          {
            db: kit.db.runtime.db,
            jobs: jobs.map(([job]) => job),
            onError: () => undefined,
            intervals: {
              pollingSeconds: 0.5,
              superviseSeconds: 1,
              cronSeconds: 1,
            },
          },
          "worker",
        );
        runners.push(runner);
        await runner.work({
          deps: kit.pipeline,
          handlers,
          drainTimeoutMs: 5_000,
        });
      }

      await waitUntil(
        () =>
          Promise.resolve([...runs.values()].every((ids) => ids.length > 0)),
        90_000,
      );
      await delay(3_000);
    } finally {
      for (const runner of runners) {
        await runner.close();
      }
    }

    expect(await schedules()).toHaveLength(MAINTENANCE_JOB_NAMES.length);
    for (const [name, ids] of runs) {
      expect(new Set(ids).size).toBe(ids.length);
      const audits = await kit.db.runtime.db
        .select({ requestId: auditLog.requestId })
        .from(auditLog)
        .where(and(eq(auditLog.actorId, name), gte(auditLog.createdAt, since)));
      expect(audits.map(({ requestId }) => requestId).toSorted()).toEqual(
        [...ids].toSorted(),
      );
      const slots = await kit.db.admin.query<{ slot: string }>(
        `SELECT singleton_on::text AS slot FROM pgboss.job
         WHERE name = '__pgboss__send-it' AND data->>'name' = $1`,
        [name],
      );
      const slotValues = slots.rows.map(({ slot }) => slot);
      expect(new Set(slotValues).size).toBe(slotValues.length);
      expect(ids.length).toBeLessThanOrEqual(slotValues.length);
    }
    expect(await remainingKeys([expiredKey, liveKey])).toEqual([liveKey]);
  }, 150_000);
});

describe("apps/worker assistant jobs at boot (SHO-651)", () => {
  function assistantConfig(enabled: boolean) {
    return loadServerConfig({
      ...testEnv(),
      AI_ASSISTANT_KIT: enabled ? "1" : "0",
      ANTHROPIC_API_KEY: "ANTHROPIC_KEY_NEVER_CALLED_IN_TESTS",
    });
  }

  function capturingLogger(lines: string[]) {
    return createProcessLogger({
      name: "worker-assistant-boot",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
  }

  const assistantQueueNames = [
    assistantTurnJob.name,
    exhaustedQueueName(assistantTurnJob),
    assistantSweepOverdueTurnsJob.name,
  ];

  async function provisioned(names: readonly string[]) {
    const rows = await kit.db.admin.query<{ name: string }>(
      "SELECT name FROM pgboss.queue WHERE name = ANY($1)",
      [[...names]],
    );
    return rows.rows.map(({ name }) => name).toSorted();
  }

  const BUDGET_KYIV_DATE = "2026-09-16";
  const PLACEHOLDER_CREATED_AT = "2026-09-16T09:00:00.000Z";
  const MICRO_USD_PER_USD = 1_000_000;
  const HOLD = {
    companyReservedMicroUsd: 250_000,
    globalReservedMicroUsd: 125_000,
  };
  const COMPANY_SPENT_USD = 1;
  const GLOBAL_SPENT_USD = 2;

  const placeholderSchema = z.object({
    parts: z.array(
      z.object({
        kind: z.string(),
        text: z.string().optional(),
        status: z.string().optional(),
      }),
    ),
  });

  async function seedQueuedTurn() {
    const companyId = kitIdentities.companies.a;
    const userId = kitIdentities.users.anna;
    const conversationId = randomUUID();
    const commandId = randomUUID();
    const placeholderMessageId = randomUUID();
    await kit.db.runtime.db
      .insert(assistantConversations)
      .values({ id: conversationId, companyId, userId });
    await kit.db.runtime.db.insert(assistantChatMessages).values({
      companyId,
      conversationId,
      seq: 1,
      messageId: placeholderMessageId,
      bind: `${userId}:${companyId}`,
      message: {
        messageId: placeholderMessageId,
        role: "assistant",
        createdAt: PLACEHOLDER_CREATED_AT,
        parts: [{ kind: "text", text: "", status: "streaming" }],
      },
    });
    await kit.db.runtime.db.insert(assistantTurns).values({
      companyId,
      conversationId,
      kind: "answer",
      commandId,
      status: "queued",
      userId,
      sessionId: "session-leftover",
      requestId: randomUUID(),
      userMessageId: null,
      placeholderMessageId,
      continuesCommandId: null,
      companyReservedMicroUsd: HOLD.companyReservedMicroUsd,
      globalReservedMicroUsd: HOLD.globalReservedMicroUsd,
      budgetKyivDate: BUDGET_KYIV_DATE,
    });
    return { companyId, conversationId, commandId, placeholderMessageId };
  }

  async function sendTurnJob(seeded: {
    readonly companyId: string;
    readonly conversationId: string;
    readonly commandId: string;
  }) {
    const runner = await openJobRunner(
      { db: kit.db.runtime.db, jobs: workerJobs, onError: () => undefined },
      "api",
    );
    try {
      await kit.db.runtime.db.transaction(async (tx) => {
        await runner.port.enqueue(tx, [
          buildJobEnvelope(assistantTurnJob, {
            companyId: seeded.companyId,
            payload: {
              kind: "answer",
              conversationId: seeded.conversationId,
              commandId: seeded.commandId,
            },
          }),
        ]);
      });
    } finally {
      await runner.close();
    }
  }

  async function turnRow(commandId: string) {
    return (
      await kit.db.runtime.db
        .select({
          status: assistantTurns.status,
          endReason: assistantTurns.endReason,
        })
        .from(assistantTurns)
        .where(eq(assistantTurns.commandId, commandId))
    )[0];
  }

  async function placeholderParts(placeholderMessageId: string) {
    const row = (
      await kit.db.runtime.db
        .select({ message: assistantChatMessages.message })
        .from(assistantChatMessages)
        .where(eq(assistantChatMessages.messageId, placeholderMessageId))
    )[0];
    return row === undefined ? [] : placeholderSchema.parse(row.message).parts;
  }

  it("provisions the turn queue, its exhaustion queue and the global sweep schedule", async () => {
    const lines: string[] = [];
    const booted = await bootWorker(assistantConfig(true), {
      logger: capturingLogger(lines),
      pollIntervalMs: 60_000,
    });
    try {
      expect(await provisioned(assistantQueueNames)).toEqual(
        [...assistantQueueNames].toSorted(),
      );
      const scheduled = await kit.db.admin.query<{ cron: string }>(
        "SELECT cron FROM pgboss.schedule WHERE name = $1",
        [assistantSweepOverdueTurnsJob.name],
      );
      expect(scheduled.rows).toEqual([
        { cron: assistantSweepOverdueTurnsJob.cron },
      ]);
      const log = lines.join("\n");
      expect(log).toMatch(/"mounted":true[^\n]*"assistant-kit path"/);
      expect(log).not.toContain("ANTHROPIC_KEY_NEVER_CALLED_IN_TESTS");
    } finally {
      await booted.close();
    }
  }, 150_000);

  it("boots with no model, closes a leftover queued turn as not_started through its exhaustion, settles its placeholder and gives its hold back", async () => {
    const lines: string[] = [];
    const seeded = await seedQueuedTurn();
    const redis = new Redis(redisUrl);
    const budget = createRedisAiBudgetStore(redis);
    const companyKey = aiCompanyBudgetKey(seeded.companyId, BUDGET_KYIV_DATE);
    const globalKey = aiGlobalBudgetKey(BUDGET_KYIV_DATE);
    const holdKey = aiBudgetHoldKey({
      companyId: seeded.companyId,
      kyivDate: BUDGET_KYIV_DATE,
      kind: "answer",
      conversationId: seeded.conversationId,
      commandId: seeded.commandId,
    });
    await budget.add(companyKey, COMPANY_SPENT_USD, AI_BUDGET_TTL_SEC);
    await budget.add(globalKey, GLOBAL_SPENT_USD, AI_BUDGET_TTL_SEC);
    await budget.claimHold(holdKey, seeded.commandId, AI_BUDGET_TTL_SEC);
    const booted = await bootWorker(assistantConfig(false), {
      logger: capturingLogger(lines),
      pollIntervalMs: 60_000,
    });
    try {
      expect(await provisioned(assistantQueueNames)).toEqual(
        [...assistantQueueNames].toSorted(),
      );
      expect(lines.join("\n")).toMatch(
        /"enabled":false,"mounted":false[^\n]*"assistant-kit path"/,
      );

      await sendTurnJob(seeded);
      await waitUntil(async () =>
        (await placeholderParts(seeded.placeholderMessageId)).some(
          (part) => part.status === "interrupted",
        ),
      );
      expect(await turnRow(seeded.commandId)).toEqual({
        status: "interrupted",
        endReason: "not_started",
      });
      expect(await placeholderParts(seeded.placeholderMessageId)).toEqual([
        { kind: "text", text: "", status: "interrupted" },
      ]);
      expect(await redis.get(holdKey)).toBeNull();
      expect(await budget.read(companyKey)).toBeCloseTo(
        COMPANY_SPENT_USD - HOLD.companyReservedMicroUsd / MICRO_USD_PER_USD,
        6,
      );
      expect(await budget.read(globalKey)).toBeCloseTo(
        GLOBAL_SPENT_USD - HOLD.globalReservedMicroUsd / MICRO_USD_PER_USD,
        6,
      );
    } finally {
      await booted.close();
      await redis.quit();
    }
  }, 150_000);
});
