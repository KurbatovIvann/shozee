import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, type SpikeDb } from "../shared/db.js";
import { spikeEffects, spikeOperations } from "../shared/schema.js";
import {
  BullmqOperationRunner,
  PREFIX,
  REDIS_CONNECTION,
  sweepDeadlines,
  type BullmqHandler,
} from "./runner.js";
import { prepareDatabase } from "./schema.js";
import {
  accept,
  effectCount,
  operation,
  pgErrorField,
  recordEffect,
  sleep,
  spawnWorker,
  waitFor,
  waitHandler,
  workHandler,
  type SpawnedWorker,
} from "./support.js";

let databaseUrl = "";
let db: SpikeDb;
let closePool: () => Promise<void>;
let redis: Redis;
const runners: BullmqOperationRunner[] = [];
const workers: SpawnedWorker[] = [];

function runner(
  queueName: string,
  overrides: Partial<ConstructorParameters<typeof BullmqOperationRunner>[0]> = {},
): BullmqOperationRunner {
  const created = new BullmqOperationRunner({
    db,
    queueName: `${queueName}-${Date.now()}`,
    claimGuard: true,
    ...overrides,
  });
  runners.push(created);
  return created;
}

async function status(operationId: string) {
  return (await operation(db, operationId))?.status;
}

async function worker(
  env: Omit<Parameters<typeof spawnWorker>[0], "databaseUrl">,
): Promise<SpawnedWorker> {
  const spawned = await spawnWorker({ databaseUrl, ...env });
  workers.push(spawned);
  return spawned;
}

beforeAll(async () => {
  databaseUrl = await prepareDatabase();
  const connection = connect(databaseUrl);
  db = connection.db;
  closePool = () => connection.pool.end();
  redis = new Redis(REDIS_CONNECTION);
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

afterAll(async () => {
  for (const spawned of workers) {
    spawned.child.kill("SIGKILL");
  }
  for (const created of runners) {
    await created.dispose();
  }
  redis.disconnect();
  await closePool();
});

describe("R1 transactional enqueue", () => {
  it("R1a native: a job added inside a rolled-back transaction still runs", async () => {
    const native = runner("r1-native", { claimGuard: false });
    await native.start(workHandler(db, 0));
    const rolledBack = await accept(db, native, {
      subjectId: randomUUID(),
      rollback: true,
    });
    await sleep(3_000);
    expect(await operation(db, rolledBack.operationId)).toBeUndefined();
    expect(await effectCount(db, rolledBack.operationId, "start")).toBe(1);
  });

  it("R1b compensated: advisory-lock claim guard drops the orphan and waits for commit", async () => {
    const guarded = runner("r1-guard");
    await guarded.start(workHandler(db, 0));
    const rolledBack = await accept(db, guarded, {
      subjectId: randomUUID(),
      rollback: true,
    });
    await sleep(3_000);
    expect(await effectCount(db, rolledBack.operationId, "delivery:%")).toBe(1);
    expect(await effectCount(db, rolledBack.operationId, "start")).toBe(0);

    const committed = await accept(db, guarded, {
      subjectId: randomUUID(),
      beforeCommit: () => sleep(500),
    });
    expect(
      await waitFor(async () => (await status(committed.operationId)) === "done", 5_000),
    ).toBe(true);
    const timeline = await db
      .select({ kind: spikeEffects.kind, at: spikeEffects.createdAt })
      .from(spikeEffects)
      .where(eq(spikeEffects.operationId, committed.operationId))
      .orderBy(asc(spikeEffects.id));
    const delivered = timeline.find((row) => row.kind.startsWith("delivery"));
    const started = timeline.find((row) => row.kind === "start");
    expect(delivered && started).toBeTruthy();
    const lockWaitMs =
      (started?.at.getTime() ?? 0) - (delivered?.at.getTime() ?? 0);
    console.log(`R1b delivery-to-start lock wait ${lockWaitMs} ms (commit delayed 500 ms)`);
    expect(lockWaitMs).toBeGreaterThanOrEqual(300);
  });
});

describe("R2 idempotent accept, one active per subject", () => {
  it("R2 same command once, second active command refused by the DB, other subject concurrent", async () => {
    const active = runner("r2");
    await active.start(workHandler(db, 1_500));
    const subjectA = randomUUID();
    const commandId = randomUUID();
    const first = await accept(db, active, { subjectId: subjectA, commandId });
    const replay = await accept(db, active, { subjectId: subjectA, commandId });
    expect(replay).toEqual({ operationId: first.operationId, created: false });

    const refusal = await accept(db, active, { subjectId: subjectA }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pgErrorField(refusal, "code")).toBe("23505");
    expect(pgErrorField(refusal, "constraint")).toBe("spike_operations_one_active");

    const other = runner("r2-other");
    await other.start(workHandler(db, 1_500));
    const concurrent = await accept(db, other, { subjectId: randomUUID() });

    expect(
      await waitFor(
        async () =>
          (await status(first.operationId)) === "done" &&
          (await status(concurrent.operationId)) === "done",
        8_000,
      ),
    ).toBe(true);
    const rows = await db
      .select()
      .from(spikeOperations)
      .where(eq(spikeOperations.commandId, commandId));
    expect(rows).toHaveLength(1);
    expect(await effectCount(db, first.operationId, "start")).toBe(1);
    const spans = await db
      .select({ op: spikeEffects.operationId, kind: spikeEffects.kind, at: spikeEffects.createdAt })
      .from(spikeEffects)
      .where(
        and(
          inArray(spikeEffects.operationId, [first.operationId, concurrent.operationId]),
          inArray(spikeEffects.kind, ["start", "end"]),
        ),
      );
    const at = (op: string, kind: string) =>
      spans.find((row) => row.op === op && row.kind === kind)?.at.getTime() ?? 0;
    expect(at(concurrent.operationId, "start")).toBeLessThan(at(first.operationId, "end"));
  });
});

describe("R3 identity-only payload", () => {
  it("R3 the Redis job hash carries only operationId and subjectId", async () => {
    const identity = runner("r3");
    await identity.start(workHandler(db, 0));
    const accepted = await accept(db, identity, { subjectId: randomUUID() });
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "done", 5_000),
    ).toBe(true);
    await waitFor(async () => (await identity.queue.getJobState(accepted.operationId)) === "completed", 3_000);
    const hash = await redis.hgetall(
      `${PREFIX}:${identity.queue.name}:${accepted.operationId}`,
    );
    const data: unknown = JSON.parse(hash.data ?? "null");
    expect(data !== null && typeof data === "object" ? Object.keys(data).sort() : []).toEqual([
      "operationId",
      "subjectId",
    ]);
    const keys = await redis.keys(`${PREFIX}:${identity.queue.name}:*`);
    console.log(`R3 job hash fields: ${Object.keys(hash).sort().join(",")}`);
    console.log(`R3 queue keys: ${keys.map((key) => key.split(":").slice(2).join(":")).sort().join(",")}`);
  });
});

describe("R4 deadline, no automatic re-run", () => {
  async function killMidRun(maxStalledCount: number) {
    const queueName = `r4-stalled${maxStalledCount}-${Date.now()}`;
    const probe = new BullmqOperationRunner({ db, queueName, claimGuard: true });
    runners.push(probe);
    const workerEnv = {
      queueName,
      scenario: "work" as const,
      workMs: 20_000,
      maxStalledCount,
      lockDurationMs: 2_000,
      stalledIntervalMs: 1_000,
    };
    const first = await worker(workerEnv);
    const accepted = await accept(db, probe, {
      subjectId: randomUUID(),
      deadlineMs: 3_000,
    });
    expect(
      await waitFor(async () => (await effectCount(db, accepted.operationId, "start")) === 1, 5_000),
    ).toBe(true);
    await first.kill();
    const killedAt = Date.now();
    const interrupted = await waitFor(async () => {
      await sweepDeadlines(db);
      return (await status(accepted.operationId)) === "interrupted";
    }, 3_000 + 1_000 + 1_000, 1_000);
    console.log(`R4 interrupted ${Date.now() - killedAt} ms after kill`);
    expect(interrupted).toBe(true);
    await worker(workerEnv);
    await waitFor(async () => {
      const state = await probe.queue.getJobState(accepted.operationId);
      return state === "failed" || state === "completed";
    }, 10_000, 250);
    await sleep(1_000);
    const job = await probe.queue.getJob(accepted.operationId);
    return {
      row: await operation(db, accepted.operationId),
      starts: await effectCount(db, accepted.operationId, "start"),
      deliveries: await effectCount(db, accepted.operationId, "delivery:%"),
      jobState: await probe.queue.getJobState(accepted.operationId),
      failedReason: job?.failedReason,
    };
  }

  it("R4a maxStalledCount 0: SIGKILL mid-run → interrupted by sweep, BullMQ fails the stalled job, no re-run", async () => {
    const result = await killMidRun(0);
    console.log(`R4a ${JSON.stringify({ ...result, row: result.row?.status })}`);
    expect(result.row?.status).toBe("interrupted");
    expect(result.row?.runs).toBe(1);
    expect(result.starts).toBe(1);
    expect(result.deliveries).toBe(1);
    expect(result.jobState).toBe("failed");
  });

  it("R4b library default maxStalledCount 1: BullMQ re-delivers the job, only the Postgres claim guard stops the re-run", async () => {
    const result = await killMidRun(1);
    console.log(`R4b ${JSON.stringify({ ...result, row: result.row?.status })}`);
    expect(result.deliveries).toBe(2);
    expect(result.starts).toBe(1);
    expect(result.row?.runs).toBe(1);
    expect(result.row?.status).toBe("interrupted");
  });
});

describe("R5 durable wait/signal", () => {
  it("R5a SIGKILL while waiting, restart, signal → continues without repeating pre-wait effects", async () => {
    const queueName = `r5-${Date.now()}`;
    const producer = new BullmqOperationRunner({ db, queueName, claimGuard: true });
    runners.push(producer);
    const first = await worker({ queueName, scenario: "wait", waitMs: 10_000 });
    const accepted = await accept(db, producer, { subjectId: randomUUID() });
    expect(
      await waitFor(
        async () =>
          (await status(accepted.operationId)) === "waiting" &&
          (await producer.queue.getJobState(accepted.operationId)) === "delayed",
        5_000,
      ),
    ).toBe(true);
    await first.kill();
    await worker({ queueName, scenario: "wait", waitMs: 10_000 });
    await producer.signal(accepted.operationId, "answer", { value: 42 });
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "done", 5_000),
    ).toBe(true);
    expect(await effectCount(db, accepted.operationId, "before-wait")).toBe(1);
    expect(await effectCount(db, accepted.operationId, 'after-wait:{"value":42}')).toBe(1);
    const invocations = await effectCount(db, accepted.operationId, "invocation");
    console.log(`R5a handler invocations (replays) ${invocations}`);
    expect(invocations).toBe(2);
    expect((await operation(db, accepted.operationId))?.runs).toBe(1);
  });

  it("R5b no signal → timeout → row failed", async () => {
    const timeout = runner("r5-timeout");
    await timeout.start(waitHandler(db, 10_000));
    const accepted = await accept(db, timeout, { subjectId: randomUUID() });
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "waiting", 5_000),
    ).toBe(true);
    await sleep(8_000);
    expect(await status(accepted.operationId)).toBe("waiting");
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "failed", 5_000),
    ).toBe(true);
    await waitFor(async () => (await timeout.queue.getJobState(accepted.operationId)) === "failed", 3_000, 20);
    const job = await timeout.queue.getJob(accepted.operationId);
    expect(job?.failedReason).toBe("answer timed out");
    expect(await effectCount(db, accepted.operationId, "before-wait")).toBe(1);
  });
});

describe("R6 one snapshot", () => {
  it("R6 row and effects agree in one REPEATABLE READ snapshot while a writer races; Redis cannot join it", async () => {
    const operationId = randomUUID();
    await db.insert(spikeOperations).values({
      id: operationId,
      subjectId: randomUUID(),
      commandId: randomUUID(),
      status: "running",
    });
    let writing = true;
    const writer = (async () => {
      let revision = 1;
      while (writing) {
        revision += 1;
        const next = revision;
        await db.transaction(async (tx) => {
          await tx
            .update(spikeOperations)
            .set({ revision: next, status: next % 2 === 0 ? "waiting" : "running" })
            .where(eq(spikeOperations.id, operationId));
          await tx.insert(spikeEffects).values({ operationId, kind: `revision:${next}` });
        });
      }
    })();
    let disagreements = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      await db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({ revision: spikeOperations.revision, status: spikeOperations.status })
            .from(spikeOperations)
            .where(eq(spikeOperations.id, operationId));
          await sleep(2);
          const [latest] = await tx
            .select({ kind: spikeEffects.kind })
            .from(spikeEffects)
            .where(and(eq(spikeEffects.operationId, operationId), like(spikeEffects.kind, "revision:%")))
            .orderBy(sql`${spikeEffects.id} desc`)
            .limit(1);
          const expected = row?.revision === 1 ? undefined : `revision:${row?.revision}`;
          if (latest?.kind !== expected) {
            disagreements += 1;
          }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    }
    writing = false;
    await writer;
    expect(disagreements).toBe(0);

    const probe = runner("r6-probe");
    await probe.start(workHandler(db, 0));
    let redisBehind = 0;
    for (let index = 0; index < 10; index += 1) {
      const accepted = await accept(db, probe, { subjectId: randomUUID() });
      await waitFor(async () => (await status(accepted.operationId)) === "done", 5_000, 5);
      const state = await probe.queue.getJobState(accepted.operationId);
      if (state !== "completed") {
        redisBehind += 1;
      }
    }
    console.log(`R6 Redis job state disagreed with Postgres 'done' in ${redisBehind}/10 samples`);
  });
});

describe("R7 concurrency", () => {
  it("R7 two workers x4, 40 operations over 10 subjects, no per-subject overlap", async () => {
    const queueName = `r7-${Date.now()}`;
    const producer = new BullmqOperationRunner({ db, queueName, claimGuard: true });
    runners.push(producer);
    await worker({ queueName, scenario: "work", workMs: 150, concurrency: 4 });
    await worker({ queueName, scenario: "work", workMs: 150, concurrency: 4 });
    const subjects = Array.from({ length: 10 }, () => randomUUID());
    let refusals = 0;
    const operationIds: string[] = [];
    await Promise.all(
      subjects.map(async (subjectId) => {
        for (let index = 0; index < 4; index += 1) {
          for (;;) {
            try {
              const accepted = await accept(db, producer, { subjectId });
              operationIds.push(accepted.operationId);
              break;
            } catch (error) {
              if (pgErrorField(error, "constraint") !== "spike_operations_one_active") {
                throw error;
              }
              refusals += 1;
              await sleep(20);
            }
          }
        }
      }),
    );
    expect(
      await waitFor(async () => {
        const rows = await db
          .select({ status: spikeOperations.status })
          .from(spikeOperations)
          .where(inArray(spikeOperations.id, operationIds));
        return rows.length === 40 && rows.every((row) => row.status === "done");
      }, 60_000, 250),
    ).toBe(true);
    const rows = await db
      .select({
        subjectId: spikeOperations.subjectId,
        operationId: spikeEffects.operationId,
        kind: spikeEffects.kind,
        at: spikeEffects.createdAt,
      })
      .from(spikeEffects)
      .innerJoin(spikeOperations, eq(spikeOperations.id, spikeEffects.operationId))
      .where(inArray(spikeEffects.operationId, operationIds));
    const spans = operationIds.map((operationId) => {
      const own = rows.filter((row) => row.operationId === operationId);
      return {
        subjectId: own[0]?.subjectId ?? "",
        start: own.find((row) => row.kind === "start")?.at.getTime() ?? 0,
        end: own.find((row) => row.kind === "end")?.at.getTime() ?? 0,
        worker: own.find((row) => row.kind.startsWith("delivery:"))?.kind ?? "",
      };
    });
    let overlaps = 0;
    for (const subjectId of subjects) {
      const ordered = spans.filter((span) => span.subjectId === subjectId).sort((a, b) => a.start - b.start);
      for (let index = 1; index < ordered.length; index += 1) {
        if ((ordered[index]?.start ?? 0) < (ordered[index - 1]?.end ?? 0)) {
          overlaps += 1;
        }
      }
    }
    let peak = 0;
    for (const span of spans) {
      peak = Math.max(peak, spans.filter((other) => other.start <= span.start && other.end > span.start).length);
    }
    const workerPids = new Set(spans.map((span) => span.worker));
    console.log(`R7 overlaps=${overlaps} peakConcurrent=${peak} workers=${workerPids.size} dbRefusals=${refusals}`);
    expect(overlaps).toBe(0);
    expect(workerPids.size).toBe(2);
  });
});

describe("R8 drain", () => {
  it("R8 stop() during a run lets it finish and takes no new work", async () => {
    const draining = runner("r8");
    await draining.start(workHandler(db, 2_000));
    const inFlight = await accept(db, draining, { subjectId: randomUUID() });
    expect(
      await waitFor(async () => (await effectCount(db, inFlight.operationId, "start")) === 1, 5_000, 20),
    ).toBe(true);
    let stopped = false;
    const stopping = draining.stop().then(() => {
      stopped = true;
    });
    await sleep(200);
    const later = await accept(db, draining, { subjectId: randomUUID() });
    expect(stopped).toBe(false);
    await stopping;
    expect(await status(inFlight.operationId)).toBe("done");
    expect(await effectCount(db, inFlight.operationId, "end")).toBe(1);
    await sleep(1_500);
    expect(await status(later.operationId)).toBe("queued");
    expect(await effectCount(db, later.operationId, "delivery:%")).toBe(0);
    expect(await draining.queue.getJobState(later.operationId)).toBe("waiting");
  });
});

describe("R9 failure visibility and replay", () => {
  it("R9 a throwing handler fails once, is visible in Postgres and Redis, and retries only explicitly", async () => {
    let calls = 0;
    const flaky: BullmqHandler = async (context) => {
      calls += 1;
      await recordEffect(db, context.operationId, "start");
      if (calls === 1) {
        throw new Error("boom");
      }
    };
    const failing = runner("r9");
    await failing.start(flaky);
    const accepted = await accept(db, failing, { subjectId: randomUUID() });
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "failed", 5_000),
    ).toBe(true);
    await sleep(2_000);
    const job = await failing.queue.getJob(accepted.operationId);
    expect(await failing.queue.getJobState(accepted.operationId)).toBe("failed");
    expect(job?.failedReason).toBe("boom");
    expect(job?.attemptsMade).toBe(1);
    expect(job?.stacktrace?.length).toBeGreaterThan(0);
    expect(await effectCount(db, accepted.operationId, "start")).toBe(1);

    expect(await failing.retryFailed(accepted.operationId)).toBe(true);
    expect(
      await waitFor(async () => (await status(accepted.operationId)) === "done", 5_000),
    ).toBe(true);
    expect((await operation(db, accepted.operationId))?.runs).toBe(2);
    expect(await effectCount(db, accepted.operationId, "start")).toBe(2);
  });
});
