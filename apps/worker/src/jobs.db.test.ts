/**
 * BullMQ job host (fnd-T29 / SHO-120 / SHO-248): maintenance scheduler
 * ticks, abandoned-upload sweep, catalog rendition backfill,
 * single-flight across replicas, drain on shutdown, log hygiene,
 * re-upsert after flush.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  enqueueAssistantTurn,
} from "@showzy/assistant-runtime";
import { createProcessLogger, loadServerConfig } from "@showzy/config";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { idempotencyKeys } from "@showzy/db";
import { files } from "@showzy/db/schema/files";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  getFilesObjectStore,
  probeFilesObjectStore,
} from "@showzy/files/storage";
import { waitForObjectVisibility } from "@showzy/files/testing";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Queue, QueueEvents } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootWorker } from "./boot.js";
import {
  createJobHost,
  type BackfillTickResult,
  type SweepTickResult,
} from "./jobs.js";
import {
  BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS,
  BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
  BULLMQ_PREFIX,
  IDEMPOTENCY_CLEANUP_JOB_NAME,
  MAINTENANCE_QUEUE_NAME,
  PDF_JOB_NAME,
  PDF_QUEUE_NAME,
  SWEEP_ABANDONED_UPLOADS_JOB_NAME,
  SWEEP_INTERVAL_MS,
} from "./policy.js";
import { createProcessShutdown } from "./shutdown.js";

const silent = pino({ enabled: false });
const REDIS_PASSWORD = "REDIS_TICK_SECRET";
const TICK_INTERVAL_MS = 400;
const SINGLE_FLIGHT_INTERVAL_MS = 5_000;
const ABANDONED_PENDING_TTL_MS = 60 * 60 * 1_000;
const LONG_INTERVAL_MS = 60 * 60 * 1_000;

/** Same pin as docker-compose.yml (ADR-0027). */
const GARAGE_IMAGE = "dxflrs/garage:v2.3.0";
const GARAGE_BUCKET = "showzy";
const GARAGE_ACCESS_KEY = "showzy-local";
const GARAGE_SECRET_KEY = "showzy-local-secret";

const jpegBytes = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

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

async function flushRedis(): Promise<void> {
  const admin = new Redis(redisUrl);
  await admin.flushdb();
  await admin.quit();
}

beforeEach(async () => {
  await flushRedis();
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
      await new Promise((resolve) => setTimeout(resolve, 250));
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
    REDIS_QUEUE_URL: redisUrl,
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

function stubSweep(): Promise<SweepTickResult> {
  return Promise.resolve({
    leftoverStagingDeleted: 0,
    abandonedPendingDeleted: 0,
  });
}

function stubBackfill(): Promise<BackfillTickResult> {
  return Promise.resolve({
    filled: 0,
    alreadyComplete: 0,
    skippedMissingOriginal: 0,
    skippedUndecodable: 0,
  });
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withMaintenanceQueue<T>(
  run: (queue: Queue) => Promise<T>,
): Promise<T> {
  const connection = new Redis(redisUrl);
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection,
    prefix: BULLMQ_PREFIX,
  });
  try {
    return await run(queue);
  } finally {
    await queue.close();
    await connection.quit();
  }
}

async function enqueueMaintenanceJob(
  jobName: string,
  jobId: string,
): Promise<void> {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const eventsConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection,
    prefix: BULLMQ_PREFIX,
  });
  const events = new QueueEvents(MAINTENANCE_QUEUE_NAME, {
    connection: eventsConnection,
    prefix: BULLMQ_PREFIX,
  });
  await events.waitUntilReady();
  try {
    const job = await queue.add(
      jobName,
      {},
      {
        jobId,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    await job.waitUntilFinished(events, 30_000);
  } finally {
    await events.close();
    await queue.close();
    await connection.quit();
    await eventsConnection.quit();
  }
}

function requireScheduler(
  schedulers: Awaited<ReturnType<Queue["getJobSchedulers"]>>,
  name: string,
) {
  const match = schedulers.find((scheduler) => scheduler.name === name);
  if (match === undefined) {
    throw new Error(`expected scheduler ${name}`);
  }
  return match;
}

async function insertKeyPair(): Promise<{
  expiredKey: string;
  liveKey: string;
}> {
  const expiredKey = randomUUID();
  const liveKey = randomUUID();
  const nowMs = Date.now();
  const action = `workerJobs.cleanup.${randomUUID()}`;
  await kit.db.runtime.db.insert(idempotencyKeys).values([
    {
      principalKey: `staff:${kit.identities.users.anna}`,
      scopeKey: `company:${kit.identities.companies.a}`,
      companyId: kit.identities.companies.a,
      action,
      key: expiredKey,
      requestHash: "c".repeat(64),
      status: "completed",
      attemptId: randomUUID(),
      leaseExpiresAt: new Date(nowMs),
      expiresAt: new Date(nowMs - 1_000),
    },
    {
      principalKey: `staff:${kit.identities.users.anna}`,
      scopeKey: `company:${kit.identities.companies.a}`,
      companyId: kit.identities.companies.a,
      action,
      key: liveKey,
      requestHash: "d".repeat(64),
      status: "completed",
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

function catalogKey(companyId: string, fileId: string): string {
  return `${companyId}/catalog/${fileId}`;
}

function catalogRenditionKey(
  companyId: string,
  fileId: string,
  rendition: "thumb" | "card" | "hero" | "full",
): string {
  return `${companyId}/catalog/${fileId}/${rendition}`;
}

function stagingKey(companyId: string, fileId: string): string {
  return `${companyId}/uploads/${fileId}`;
}

/** 1×1 RGB PNG (IHDR + 1-pixel IDAT). Sharp-decodable for backfill ticks. */
const pngBytes = Uint8Array.from(
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082",
    "hex",
  ),
);

async function insertFileRow(values: {
  readonly id: string;
  readonly companyId: string;
  readonly uploadedByUserId: string;
  readonly status: "pending" | "ready";
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly stagingPurgedAt?: Date;
  readonly mimeType?: "image/jpeg" | "image/png";
  readonly byteSize?: number;
}): Promise<void> {
  await kit.db.runtime.db.insert(files).values({
    id: values.id,
    companyId: values.companyId,
    uploadedByUserId: values.uploadedByUserId,
    purpose: "catalog",
    objectKey: catalogKey(values.companyId, values.id),
    mimeType: values.mimeType ?? "image/jpeg",
    byteSize: BigInt(values.byteSize ?? jpegBytes.byteLength),
    checksumSha256: "a".repeat(64),
    status: values.status,
    ...(values.createdAt !== undefined ? { createdAt: values.createdAt } : {}),
    ...(values.updatedAt !== undefined ? { updatedAt: values.updatedAt } : {}),
    ...(values.stagingPurgedAt !== undefined
      ? { stagingPurgedAt: values.stagingPurgedAt }
      : {}),
  });
}

async function putStoreObject(
  key: string,
  bytes: Uint8Array = jpegBytes,
  mimeType: "image/jpeg" | "image/png" = "image/jpeg",
): Promise<void> {
  const store = getFilesObjectStore();
  await store.putObject({
    key,
    mimeType,
    bytes,
  });
  // Garage can acknowledge PutObject before HeadObject sees the key.
  // Sweep treats a missing HEAD as "already purged" and would skip delete.
  await waitForObjectVisibility(store, key, "present");
}

async function fileRow(id: string): Promise<
  | {
      readonly status: string;
      readonly updatedAt: Date;
      readonly stagingPurgedAt: Date | null;
    }
  | undefined
> {
  const rows = await kit.db.runtime.db
    .select({
      status: files.status,
      updatedAt: files.updatedAt,
      stagingPurgedAt: files.stagingPurgedAt,
    })
    .from(files)
    .where(eq(files.id, id));
  return rows[0];
}

describe("apps/worker BullMQ job host (fnd-T29)", () => {
  it("boots, registers three maintenance schedulers, and a tick deletes expired keys only", async () => {
    const { expiredKey, liveKey } = await insertKeyPair();
    const booted = await bootWorker(testConfig(), {
      logger: silent,
      pollIntervalMs: 60_000,
      cleanupIntervalMs: TICK_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
    try {
      const schedulers = await withMaintenanceQueue((queue) =>
        queue.getJobSchedulers(),
      );
      expect(schedulers).toHaveLength(3);
      expect(
        requireScheduler(schedulers, IDEMPOTENCY_CLEANUP_JOB_NAME).every,
      ).toBe(TICK_INTERVAL_MS);
      expect(
        requireScheduler(schedulers, SWEEP_ABANDONED_UPLOADS_JOB_NAME).every,
      ).toBe(LONG_INTERVAL_MS);
      expect(
        requireScheduler(schedulers, BACKFILL_CATALOG_RENDITIONS_JOB_NAME)
          .every,
      ).toBe(LONG_INTERVAL_MS);

      await waitUntil(async () => {
        const remaining = await remainingKeys([expiredKey, liveKey]);
        return remaining.length === 1 && remaining[0] === liveKey;
      });
      expect(await remainingKeys([expiredKey, liveKey])).toEqual([liveKey]);
    } finally {
      await booted.close();
    }
  });

  it("processes a given scheduled tick once across two hosts sharing Redis", async () => {
    let runs = 0;
    const hostA = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-replica-a",
      cleanupIntervalMs: SINGLE_FLIGHT_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      cleanup: () => {
        runs += 1;
        return Promise.resolve(0);
      },
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    const hostB = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-replica-b",
      cleanupIntervalMs: SINGLE_FLIGHT_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      cleanup: () => {
        runs += 1;
        return Promise.resolve(0);
      },
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    await hostA.start();
    await hostB.start();
    try {
      const schedulers = await withMaintenanceQueue((queue) =>
        queue.getJobSchedulers(),
      );
      expect(schedulers).toHaveLength(3);
      await waitUntil(() => Promise.resolve(runs >= 1), 15_000);
      await hostA.close();
      await hostB.close();
      await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS * 2));
      expect(runs).toBe(1);
    } finally {
      await hostA.close();
      await hostB.close();
    }
  });

  it("drains an in-flight maintenance job then ignores a second shutdown", async () => {
    let release: (() => void) | undefined;
    let entered = false;
    const host = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-drain",
      cleanupIntervalMs: 60_000,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      cleanup: () => {
        entered = true;
        return new Promise((resolve) => {
          release = () => {
            resolve(0);
          };
        });
      },
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    await host.start();
    let closes = 0;
    const shutdown = createProcessShutdown({
      logger: silent,
      close: () => {
        closes += 1;
        return host.close();
      },
      flush: () => Promise.resolve(),
    });
    try {
      await withMaintenanceQueue((queue) =>
        queue.add(IDEMPOTENCY_CLEANUP_JOB_NAME, {}),
      );
      await waitUntil(() => Promise.resolve(entered));
      const first = shutdown.run();
      const second = shutdown.run();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(closes).toBe(1);
      if (release === undefined) {
        throw new Error("expected an in-flight maintenance job");
      }
      release();
      await Promise.all([first, second]);
      expect(closes).toBe(1);
    } finally {
      if (release !== undefined) {
        release();
      }
      await shutdown.run();
    }
  });

  it("does not write secrets or the Redis URL in tick logs", async () => {
    const lines: string[] = [];
    const logger = createProcessLogger({
      name: "worker-jobs-logs",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    const { expiredKey, liveKey } = await insertKeyPair();
    const host = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger,
      workerId: "jobs-logs",
      cleanupIntervalMs: TICK_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    await host.start();
    try {
      await waitUntil(async () => {
        const remaining = await remainingKeys([expiredKey, liveKey]);
        return remaining.length === 1 && remaining[0] === liveKey;
      });
      const payload = lines.join("\n");
      expect(payload).toContain("expired idempotency keys cleaned");
      expect(payload).not.toContain(REDIS_PASSWORD);
      expect(payload).not.toContain(redisUrl);
    } finally {
      await host.close();
    }
  });

  it("re-upserts three schedulers after flushing BullMQ keys so the next tick still runs", async () => {
    const first = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-flush-1",
      cleanupIntervalMs: TICK_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    await first.start();
    await waitUntil(async () => {
      const schedulers = await withMaintenanceQueue((queue) =>
        queue.getJobSchedulers(),
      );
      return schedulers.length === 3;
    });
    await first.close();

    const admin = new Redis(redisUrl);
    await admin.flushdb();
    await admin.quit();

    const afterFlush = await withMaintenanceQueue((queue) =>
      queue.getJobSchedulers(),
    );
    expect(afterFlush).toHaveLength(0);

    const { expiredKey, liveKey } = await insertKeyPair();
    const second = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-flush-2",
      cleanupIntervalMs: TICK_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      sweep: stubSweep,
      backfill: stubBackfill,
    });
    await second.start();
    try {
      const restored = await withMaintenanceQueue((queue) =>
        queue.getJobSchedulers(),
      );
      expect(restored).toHaveLength(3);
      expect(
        requireScheduler(restored, IDEMPOTENCY_CLEANUP_JOB_NAME).name,
      ).toBe(IDEMPOTENCY_CLEANUP_JOB_NAME);
      expect(
        requireScheduler(restored, SWEEP_ABANDONED_UPLOADS_JOB_NAME).name,
      ).toBe(SWEEP_ABANDONED_UPLOADS_JOB_NAME);
      expect(
        requireScheduler(restored, BACKFILL_CATALOG_RENDITIONS_JOB_NAME).name,
      ).toBe(BACKFILL_CATALOG_RENDITIONS_JOB_NAME);
      await waitUntil(async () => {
        const remaining = await remainingKeys([expiredKey, liveKey]);
        return remaining.length === 1 && remaining[0] === liveKey;
      });
    } finally {
      await second.close();
    }
  });
});

describe("apps/worker sweepAbandonedUploads scheduler (SHO-120)", () => {
  async function bootSweepHost(logger: Logger = silent) {
    return bootWorker(testConfig(), {
      logger,
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
  }

  it("configures the object store so a worker-shaped sweep does not throw not-configured", async () => {
    closeFilesObjectStore();
    expect(() => getFilesObjectStore()).toThrow(CoreInvariantError);
    expect(() => getFilesObjectStore()).toThrow(
      /object store is not configured/,
    );

    const booted = await bootSweepHost();
    try {
      expect(getFilesObjectStore()).toBeDefined();
      const dueId = randomUUID();
      await insertFileRow({
        id: dueId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      });
      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );
      expect(await fileRow(dueId)).toBeUndefined();
    } finally {
      await booted.close();
    }
  });

  it("deletes a due pending row and leaves a young pending row (SHO-116)", async () => {
    const dueId = randomUUID();
    const youngId = randomUUID();
    await putStoreObject(stagingKey(kitIdentities.companies.a, dueId));
    await putStoreObject(catalogKey(kitIdentities.companies.a, dueId));
    await putStoreObject(stagingKey(kitIdentities.companies.a, youngId));
    await insertFileRow({
      id: dueId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
    });
    await insertFileRow({
      id: youngId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
    });
    const booted = await bootSweepHost();
    try {
      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );

      expect(await fileRow(dueId)).toBeUndefined();
      expect(await fileRow(youngId)).toMatchObject({ status: "pending" });
      const store = getFilesObjectStore();
      const dueStaging = stagingKey(kitIdentities.companies.a, dueId);
      const dueCatalog = catalogKey(kitIdentities.companies.a, dueId);
      await waitForObjectVisibility(store, dueStaging, "missing");
      await waitForObjectVisibility(store, dueCatalog, "missing");
      expect(await store.headObject(dueStaging)).toBe("missing");
      expect(await store.headObject(dueCatalog)).toBe("missing");
      expect(
        await store.headObject(stagingKey(kitIdentities.companies.a, youngId)),
      ).not.toBe("missing");
    } finally {
      await booted.close();
    }
  });

  it("deletes leftover staging, keeps catalog bytes, and skips already-purged rows", async () => {
    const leftoverId = randomUUID();
    const purgedId = randomUUID();
    // Seed bytes before the worker: a boot scheduler tick can mark a ready
    // row purged on a staging HEAD miss, then a later PUT leaves orphans.
    await putStoreObject(catalogKey(kitIdentities.companies.a, leftoverId));
    await putStoreObject(stagingKey(kitIdentities.companies.a, leftoverId));
    await putStoreObject(catalogKey(kitIdentities.companies.a, purgedId));
    await insertFileRow({
      id: leftoverId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      updatedAt: new Date(0),
    });
    await insertFileRow({
      id: purgedId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      updatedAt: new Date(0),
      stagingPurgedAt: new Date(0),
    });
    const booted = await bootSweepHost();
    try {
      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );

      const store = getFilesObjectStore();
      const leftoverStaging = stagingKey(kitIdentities.companies.a, leftoverId);
      const afterFirst = await fileRow(leftoverId);
      const purgedAfterFirst = await fileRow(purgedId);
      if (afterFirst === undefined || purgedAfterFirst === undefined) {
        throw new Error("expected ready rows to remain");
      }
      expect(afterFirst.stagingPurgedAt).not.toBeNull();
      await waitForObjectVisibility(store, leftoverStaging, "missing");
      expect(await store.headObject(leftoverStaging)).toBe("missing");
      expect(
        await store.headObject(
          catalogKey(kitIdentities.companies.a, leftoverId),
        ),
      ).not.toBe("missing");
      expect(
        await store.headObject(catalogKey(kitIdentities.companies.a, purgedId)),
      ).not.toBe("missing");
      expect(purgedAfterFirst.stagingPurgedAt?.getTime()).toBe(0);
      expect(purgedAfterFirst.updatedAt.getTime()).toBe(0);

      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );
      const afterSecond = await fileRow(leftoverId);
      const purgedAfterSecond = await fileRow(purgedId);
      expect(afterSecond?.stagingPurgedAt?.getTime()).toBe(
        afterFirst.stagingPurgedAt?.getTime(),
      );
      expect(afterSecond?.updatedAt.getTime()).toBe(
        afterFirst.updatedAt.getTime(),
      );
      expect(purgedAfterSecond?.updatedAt.getTime()).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("does not delete another company's catalog while sweeping as system/global", async () => {
    const abandonedId = randomUUID();
    const foreignReadyId = randomUUID();
    await putStoreObject(stagingKey(kitIdentities.companies.a, abandonedId));
    await putStoreObject(catalogKey(kitIdentities.companies.b, foreignReadyId));
    await insertFileRow({
      id: abandonedId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
    });
    await insertFileRow({
      id: foreignReadyId,
      companyId: kitIdentities.companies.b,
      uploadedByUserId: kitIdentities.users.boris,
      status: "ready",
      updatedAt: new Date(0),
      stagingPurgedAt: new Date(0),
    });
    const booted = await bootSweepHost();
    try {
      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );

      expect(await fileRow(abandonedId)).toBeUndefined();
      expect(await fileRow(foreignReadyId)).toMatchObject({ status: "ready" });
      const store = getFilesObjectStore();
      await waitForObjectVisibility(
        store,
        stagingKey(kitIdentities.companies.a, abandonedId),
        "missing",
      );
      expect(
        await store.headObject(
          catalogKey(kitIdentities.companies.b, foreignReadyId),
        ),
      ).not.toBe("missing");
    } finally {
      await booted.close();
    }
  });

  it("logs counts only — no URL or object key", async () => {
    const lines: string[] = [];
    const logger = createProcessLogger({
      name: "worker-sweep-logs",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    const dueId = randomUUID();
    await putStoreObject(stagingKey(kitIdentities.companies.a, dueId));
    await insertFileRow({
      id: dueId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
    });
    const booted = await bootSweepHost(logger);
    try {
      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );
      const payload = lines.join("\n");
      expect(payload).toContain("abandoned uploads swept");
      expect(payload).toContain("abandoned_pending_deleted");
      expect(payload).toContain("leftover_staging_deleted");
      expect(payload).not.toContain(dueId);
      expect(payload).not.toMatch(/\/catalog\//);
      expect(payload).not.toMatch(/\/uploads\//);
      expect(payload).not.toContain(garageEndpoint);
      expect(payload).not.toContain(GARAGE_SECRET_KEY);
    } finally {
      await booted.close();
    }
  });

  it("replays one idempotency key without extra deletes; a fresh key continues", async () => {
    const firstId = randomUUID();
    await putStoreObject(stagingKey(kitIdentities.companies.a, firstId));
    await insertFileRow({
      id: firstId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "pending",
      createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
    });
    const booted = await bootSweepHost();
    try {
      const replayKey = randomUUID();
      await enqueueMaintenanceJob(SWEEP_ABANDONED_UPLOADS_JOB_NAME, replayKey);
      expect(await fileRow(firstId)).toBeUndefined();
      await waitForObjectVisibility(
        getFilesObjectStore(),
        stagingKey(kitIdentities.companies.a, firstId),
        "missing",
      );

      const secondId = randomUUID();
      await putStoreObject(stagingKey(kitIdentities.companies.a, secondId));
      await insertFileRow({
        id: secondId,
        companyId: kitIdentities.companies.a,
        uploadedByUserId: kitIdentities.users.anna,
        status: "pending",
        createdAt: new Date(Date.now() - ABANDONED_PENDING_TTL_MS - 1_000),
      });
      await enqueueMaintenanceJob(SWEEP_ABANDONED_UPLOADS_JOB_NAME, replayKey);
      expect(await fileRow(secondId)).toMatchObject({ status: "pending" });

      await enqueueMaintenanceJob(
        SWEEP_ABANDONED_UPLOADS_JOB_NAME,
        randomUUID(),
      );
      expect(await fileRow(secondId)).toBeUndefined();
      await waitForObjectVisibility(
        getFilesObjectStore(),
        stagingKey(kitIdentities.companies.a, secondId),
        "missing",
      );
    } finally {
      await booted.close();
    }
  });

  it("processes a given sweep tick once across two hosts sharing Redis", async () => {
    let runs = 0;
    const hostA = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-sweep-replica-a",
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: SINGLE_FLIGHT_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      cleanup: () => Promise.resolve(0),
      sweep: () => {
        runs += 1;
        return Promise.resolve({
          leftoverStagingDeleted: 0,
          abandonedPendingDeleted: 0,
        });
      },
      backfill: stubBackfill,
    });
    const hostB = createJobHost({
      redisUrl,
      db: kit.db.runtime.db,
      logger: silent,
      workerId: "jobs-sweep-replica-b",
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: SINGLE_FLIGHT_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
      cleanup: () => Promise.resolve(0),
      sweep: () => {
        runs += 1;
        return Promise.resolve({
          leftoverStagingDeleted: 0,
          abandonedPendingDeleted: 0,
        });
      },
      backfill: stubBackfill,
    });
    await hostA.start();
    await hostB.start();
    try {
      await waitUntil(() => Promise.resolve(runs >= 1), 15_000);
      await hostA.close();
      await hostB.close();
      await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS * 2));
      expect(runs).toBe(1);
    } finally {
      await hostA.close();
      await hostB.close();
    }
  });

  it("keeps the default sweep and backfill intervals at 5 minutes when boot omits an override", async () => {
    const booted = await bootWorker(testConfig(), {
      logger: silent,
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
    });
    try {
      const schedulers = await withMaintenanceQueue((queue) =>
        queue.getJobSchedulers(),
      );
      expect(
        requireScheduler(schedulers, SWEEP_ABANDONED_UPLOADS_JOB_NAME).every,
      ).toBe(SWEEP_INTERVAL_MS);
      expect(
        requireScheduler(schedulers, BACKFILL_CATALOG_RENDITIONS_JOB_NAME)
          .every,
      ).toBe(BACKFILL_CATALOG_RENDITIONS_INTERVAL_MS);
    } finally {
      await booted.close();
    }
  });
});

describe("apps/worker backfillCatalogRenditions scheduler (SHO-248)", () => {
  async function bootBackfillHost(logger: Logger = silent) {
    return bootWorker(testConfig(), {
      logger,
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
  }

  it("schedules the job on maintenance and fills missing catalog renditions", async () => {
    const fileId = randomUUID();
    await putStoreObject(
      catalogKey(kitIdentities.companies.a, fileId),
      pngBytes,
      "image/png",
    );
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      mimeType: "image/png",
      byteSize: pngBytes.byteLength,
      stagingPurgedAt: new Date(0),
      createdAt: new Date("1900-01-01T00:00:00.000Z"),
    });
    const booted = await bootBackfillHost();
    try {
      await enqueueMaintenanceJob(
        BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
        randomUUID(),
      );
      const store = getFilesObjectStore();
      for (const rendition of ["thumb", "card", "hero", "full"] as const) {
        const key = catalogRenditionKey(
          kitIdentities.companies.a,
          fileId,
          rendition,
        );
        await waitForObjectVisibility(store, key, "present");
        expect(await store.headObject(key)).not.toBe("missing");
      }
      const original = await store.getObject(
        catalogKey(kitIdentities.companies.a, fileId),
      );
      expect(original).not.toBe("missing");
      if (original === "missing") {
        throw new Error("expected original catalog object after backfill");
      }
      expect(original.byteSize).toBe(pngBytes.byteLength);
      expect(original.bytes).toEqual(pngBytes);
    } finally {
      await booted.close();
    }
  });

  it("logs counts only — no URL, object key, or file id", async () => {
    const lines: string[] = [];
    const logger = createProcessLogger({
      name: "worker-backfill-logs",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    const fileId = randomUUID();
    await putStoreObject(
      catalogKey(kitIdentities.companies.a, fileId),
      pngBytes,
      "image/png",
    );
    await insertFileRow({
      id: fileId,
      companyId: kitIdentities.companies.a,
      uploadedByUserId: kitIdentities.users.anna,
      status: "ready",
      mimeType: "image/png",
      byteSize: pngBytes.byteLength,
      stagingPurgedAt: new Date(0),
      createdAt: new Date("1900-01-01T00:00:00.000Z"),
    });
    const booted = await bootBackfillHost(logger);
    try {
      await enqueueMaintenanceJob(
        BACKFILL_CATALOG_RENDITIONS_JOB_NAME,
        randomUUID(),
      );
      const payload = lines.join("\n");
      expect(payload).toContain("catalog renditions backfilled");
      expect(payload).toContain("filled");
      expect(payload).toContain("already_complete");
      expect(payload).not.toContain(fileId);
      expect(payload).not.toMatch(/\/catalog\//);
      expect(payload).not.toContain(garageEndpoint);
      expect(payload).not.toContain(GARAGE_SECRET_KEY);
    } finally {
      await booted.close();
    }
  });
});

/**
 * SHO-569. Boot mounts the assistant queue on the API's rule, on the queue
 * Redis. The shared and the queue Redis are two logical databases of the test
 * container, so a key on the wrong one is visible. The job names no turn: the
 * boot-composed processor reads Postgres, answers `no_turn`, and never reaches
 * a model (the configured key is never used).
 */
describe("apps/worker assistant queue at boot (SHO-569)", () => {
  const queueUrl = () => `${redisUrl}/1`;

  function assistantConfig(enabled: boolean) {
    return loadServerConfig({
      ...testEnv(),
      REDIS_QUEUE_URL: queueUrl(),
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

  async function withAssistantQueue<T>(
    run: (queue: Queue) => Promise<T>,
  ): Promise<T> {
    const connection = new Redis(queueUrl(), { maxRetriesPerRequest: null });
    const queue = new Queue(ASSISTANT_QUEUE_NAME, {
      connection,
      prefix: ASSISTANT_QUEUE_PREFIX,
    });
    try {
      return await run(queue);
    } finally {
      await queue.close();
      await connection.quit();
    }
  }

  it("processes a turn's job from the queue Redis and puts no queue key on the shared Redis", async () => {
    const lines: string[] = [];
    const booted = await bootWorker(assistantConfig(true), {
      logger: capturingLogger(lines),
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
    try {
      await withAssistantQueue(async (queue) => {
        expect(await queue.getWorkersCount()).toBeGreaterThan(0);
        await enqueueAssistantTurn(queue, {
          version: 1,
          kind: "chat",
          conversationId: randomUUID(),
          commandId: randomUUID(),
        });
        await waitUntil(() =>
          Promise.resolve(
            lines.some((line) => line.includes("assistant job processed")),
          ),
        );
        // The processor logs before BullMQ records the job as completed.
        await waitUntil(async () =>
          Object.values(await queue.getJobCounts()).every(
            (count) => count === 0,
          ),
        );
        const counts = await queue.getJobCounts();
        expect(Object.values(counts).every((count) => count === 0)).toBe(true);
      });

      const log = lines.join("\n");
      expect(log).toContain('"outcome":"no_turn"');
      expect(log).toMatch(/"mounted":true[^\n]*"assistant-kit path"/);
      expect(log).not.toContain("ANTHROPIC_KEY_NEVER_CALLED_IN_TESTS");

      const shared = new Redis(redisUrl);
      const onShared = await shared.keys(
        `${ASSISTANT_QUEUE_PREFIX}:${ASSISTANT_QUEUE_NAME}:*`,
      );
      await shared.quit();
      expect(onShared).toEqual([]);
    } finally {
      await booted.close();
    }
  });

  it("does not start the assistant queue when the assistant is off", async () => {
    const lines: string[] = [];
    const booted = await bootWorker(assistantConfig(false), {
      logger: capturingLogger(lines),
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
    try {
      await withAssistantQueue(async (queue) => {
        expect(await queue.getWorkersCount()).toBe(0);
      });
      expect(lines.join("\n")).toMatch(
        /"enabled":false,"mounted":false[^\n]*"assistant-kit path"/,
      );
    } finally {
      await booted.close();
    }
  });
});

describe("apps/worker pdf queue (SHO-236)", () => {
  it("starts the pdf queue and the thin processor rejects a non-envelope", async () => {
    const booted = await bootWorker(testConfig(), {
      logger: silent,
      pollIntervalMs: 60_000,
      cleanupIntervalMs: LONG_INTERVAL_MS,
      sweepIntervalMs: LONG_INTERVAL_MS,
      backfillIntervalMs: LONG_INTERVAL_MS,
    });
    try {
      const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const eventsConnection = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
      });
      const queue = new Queue(PDF_QUEUE_NAME, {
        connection,
        prefix: BULLMQ_PREFIX,
      });
      const events = new QueueEvents(PDF_QUEUE_NAME, {
        connection: eventsConnection,
        prefix: BULLMQ_PREFIX,
      });
      await events.waitUntilReady();
      try {
        const job = await queue.add(
          PDF_JOB_NAME,
          { companyId: kitIdentities.companies.a },
          {
            jobId: randomUUID(),
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );
        await expect(job.waitUntilFinished(events, 30_000)).rejects.toThrow();
      } finally {
        await events.close();
        await queue.close();
        await connection.quit();
        await eventsConnection.quit();
      }
    } finally {
      await booted.close();
    }
  });
});
