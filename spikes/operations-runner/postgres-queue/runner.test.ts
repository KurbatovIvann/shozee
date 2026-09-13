import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { spikeEffects, spikeOperations } from "../shared/schema.js";
import {
  accept,
  effects,
  jobsFor,
  killWorker,
  operation,
  setupDatabase,
  spawnWorker,
  waitFor,
  type SpawnedWorker,
} from "./harness.js";
import { scenarioHandlers, type ScenarioName } from "./handlers.js";
import { PgBossOperationRunner } from "./runner.js";

let url = "";
const opened: PgBossOperationRunner[] = [];
const spawned: SpawnedWorker[] = [];

async function openRunner(
  queue: string,
  role: "api" | "worker",
  handler?: ScenarioName,
  concurrency = 1,
): Promise<PgBossOperationRunner> {
  const runner = await PgBossOperationRunner.open({ url, queue, role, concurrency });
  opened.push(runner);
  if (handler) {
    await runner.start(scenarioHandlers(runner.db)[handler]);
  }
  return runner;
}

function startWorker(queue: string, handler: ScenarioName, concurrency = 1): SpawnedWorker {
  const worker = spawnWorker({ url, queue, handler, concurrency });
  spawned.push(worker);
  return worker;
}

function pgCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return pgCode(error.cause);
}

function report(label: string, value: unknown): void {
  process.stdout.write(`[pgq] ${label}: ${JSON.stringify(value)}\n`);
}

beforeAll(async () => {
  url = await setupDatabase();
});

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((worker) => killWorker(worker)));
  await Promise.allSettled(opened.splice(0).map((runner) => runner.stop()));
});

afterAll(async () => {
  await Promise.allSettled(opened.map((runner) => runner.stop()));
});

describe("postgres-queue (pg-boss)", () => {
  it("R1 transactional enqueue: rollback never runs, commit runs", async () => {
    const api = await openRunner("r1", "api");
    const worker = await openRunner("r1", "worker", "quick");
    const rolledBack = await accept(api, { rollback: true });
    const latencies: number[] = [];
    for (let sample = 0; sample < 10; sample += 1) {
      const committed = await accept(api, {});
      const acceptedAt = Date.now();
      await waitFor(async () => (await effects(worker.db, committed.operationId)).includes("ran"), 10_000, 5);
      latencies.push(Date.now() - acceptedAt);
    }
    await sleep(3_000);
    expect(await operation(api.db, rolledBack.operationId)).toBeUndefined();
    expect(await jobsFor(api.db, rolledBack.operationId)).toEqual([]);
    expect(await effects(api.db, rolledBack.operationId)).toEqual([]);
    report("R1 commit-to-handler latency ms", latencies.sort((a, b) => a - b));
  });

  it("R2 idempotent accept, one active per subject refused by the DB, other subject concurrent", async () => {
    const api = await openRunner("r2", "api");
    await openRunner("r2", "worker", "settle", 2);
    const commandId = randomUUID();
    const subjectId = randomUUID();
    const first = await accept(api, { commandId, subjectId });
    const again = await accept(api, { commandId, subjectId });
    expect(again.operationId).toBe(first.operationId);
    const refused = await accept(api, { subjectId }).then(
      () => "accepted",
      (error: unknown) => pgCode(error),
    );
    expect(refused).toBe("23505");
    const other = await accept(api, {});
    await waitFor(async () => (await operation(api.db, first.operationId))?.status === "done", 15_000);
    await waitFor(async () => (await operation(api.db, other.operationId))?.status === "done", 15_000);
    const rows = await api.db
      .select({ id: spikeOperations.id })
      .from(spikeOperations)
      .where(eq(spikeOperations.commandId, commandId));
    expect(rows).toHaveLength(1);
    expect(await effects(api.db, first.operationId)).toEqual(["start", "end"]);
    expect((await operation(api.db, first.operationId))?.runs).toBe(1);
    const mainJobs = (await jobsFor(api.db, first.operationId)).filter((job) => job.name === "r2");
    expect(mainJobs).toHaveLength(1);
    const timeline = await api.db.execute<{ operation_id: string; kind: string }>(
      sql`SELECT operation_id, kind FROM spike_effects WHERE operation_id IN (${first.operationId}, ${other.operationId}) ORDER BY id`,
    );
    const kinds = timeline.rows.map((row) => `${row.operation_id === first.operationId ? "A" : "B"}:${row.kind}`);
    expect(kinds.indexOf("B:start")).toBeLessThan(kinds.indexOf("A:end"));
  });

  it("R4 deadline: SIGKILL mid-run is interrupted and never re-run", async () => {
    const api = await openRunner("r4", "api");
    const first = startWorker("r4", "slow");
    await first.ready;
    const accepted = await accept(api, { deadlineMs: 4_000 });
    await waitFor(async () => (await effects(api.db, accepted.operationId)).includes("start"), 10_000);
    await killWorker(first);
    const killedAt = Date.now();
    const second = startWorker("r4", "slow");
    await second.ready;
    await waitFor(
      async () => (await operation(api.db, accepted.operationId))?.status === "interrupted",
      15_000,
    );
    report("R4 kill-to-interrupted ms (deadline 4000 from accept)", Date.now() - killedAt);
    const expired = await waitFor(async () => {
      const jobs = await jobsFor(api.db, accepted.operationId);
      const main = jobs.find((job) => job.name === "r4");
      return main?.state === "failed" ? main : undefined;
    }, 15_000);
    report("R4 killed job final state/output", expired);
    await sleep(3_000);
    const row = await operation(api.db, accepted.operationId);
    expect(row?.status).toBe("interrupted");
    expect(row?.runs).toBe(1);
    expect(await effects(api.db, accepted.operationId)).toEqual(["start"]);
    const queue = await api.boss.getQueue("r4");
    expect(queue?.retryLimit).toBe(0);
  });

  it("R5 wait survives SIGKILL and resumes on signal without repeating pre-wait effects (compensation)", async () => {
    const api = await openRunner("r5", "api");
    const first = startWorker("r5", "wait");
    await first.ready;
    const accepted = await accept(api, { deadlineMs: 60_000 });
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "waiting", 10_000);
    await killWorker(first);
    const second = startWorker("r5", "wait");
    await second.ready;
    const signalledAt = Date.now();
    await api.signal(accepted.operationId, "answer", { ok: true });
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "done", 15_000);
    report("R5 signal-to-done ms", Date.now() - signalledAt);
    const recorded = await effects(api.db, accepted.operationId);
    expect(recorded).toEqual(["invoked", "before", "invoked", 'after:{"ok":true}']);
    expect(recorded.filter((kind) => kind === "before")).toHaveLength(1);
    expect((await operation(api.db, accepted.operationId))?.runs).toBe(1);
    const jobs = await jobsFor(api.db, accepted.operationId);
    report("R5 jobs per waited operation", jobs.map((job) => `${job.name}:${job.state}`));
  });

  it("R5 no signal: wait times out and the row fails", async () => {
    const api = await openRunner("r5t", "api");
    const worker = startWorker("r5t", "wait");
    await worker.ready;
    const accepted = await accept(api, { deadlineMs: 60_000 });
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "waiting", 10_000);
    const waitingAt = Date.now();
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "failed", 20_000, 100);
    report("R5 waiting-to-failed ms (timeout 10000)", Date.now() - waitingAt);
    const late = await api.signal(accepted.operationId, "answer", { late: true }).then(() => "ok");
    expect(late).toBe("ok");
    await sleep(1_500);
    expect((await operation(api.db, accepted.operationId))?.status).toBe("failed");
    expect(await effects(api.db, accepted.operationId)).toEqual(["invoked", "before"]);
  });

  it("R6 one REPEATABLE READ snapshot: row and pg-boss job agree while a writer races", async () => {
    const api = await openRunner("r6", "api");
    await openRunner("r6", "worker", "quick", 4);
    const accepted: string[] = [];
    let writing = true;
    const writer = (async () => {
      while (writing) {
        accepted.push((await accept(api, {})).operationId);
      }
    })();
    await waitFor(async () => accepted.length > 5, 10_000);
    let rowAheadOfJob = 0;
    let terminalRows = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const operationId = accepted[accepted.length - 1 - (iteration % 5)] ?? "";
      const snapshot = await api.db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({ status: spikeOperations.status })
            .from(spikeOperations)
            .where(eq(spikeOperations.id, operationId));
          const jobs = await tx.execute<{ state: string }>(
            sql`SELECT state FROM pgboss.job WHERE name = 'r6' AND data->>'operationId' = ${operationId}`,
          );
          return { row, jobs: jobs.rows };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      expect(snapshot.row).toBeDefined();
      expect(snapshot.jobs).toHaveLength(1);
      const jobState = snapshot.jobs[0]?.state;
      if (jobState === "completed") {
        expect(snapshot.row?.status).toBe("done");
      }
      if (snapshot.row?.status === "queued") {
        expect(["created", "active"]).toContain(jobState);
      }
      if (snapshot.row?.status === "done") {
        terminalRows += 1;
        if (jobState !== "completed") {
          rowAheadOfJob += 1;
        }
      }
    }
    writing = false;
    await writer;
    report("R6 snapshots with row done but job not yet completed", { rowAheadOfJob, terminalRows });
    const stale = await api.db
      .select({ id: spikeOperations.id })
      .from(spikeOperations)
      .where(inArray(spikeOperations.id, accepted.slice(0, 5)));
    expect(stale).toHaveLength(5);
  });

  it("R7 two worker processes x4: no two operations of one subject overlap, all finish", async () => {
    const api = await openRunner("r7", "api");
    const workers = [startWorker("r7", "overlap", 4), startWorker("r7", "overlap", 4)];
    await Promise.all(workers.map((worker) => worker.ready));
    const subjects = Array.from({ length: 10 }, () => randomUUID());
    const operationIds: string[] = [];
    const startedAt = Date.now();
    await Promise.all(
      subjects.map(async (subjectId) => {
        for (let index = 0; index < 4; index += 1) {
          const accepted = await accept(api, { subjectId });
          operationIds.push(accepted.operationId);
          await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "done", 30_000);
        }
      }),
    );
    report("R7 40 operations wall ms", Date.now() - startedAt);
    const timeline = await api.db
      .select({
        operationId: spikeEffects.operationId,
        subjectId: spikeOperations.subjectId,
        kind: spikeEffects.kind,
      })
      .from(spikeEffects)
      .innerJoin(spikeOperations, eq(spikeOperations.id, spikeEffects.operationId))
      .where(inArray(spikeOperations.subjectId, subjects))
      .orderBy(asc(spikeEffects.id));
    const running = new Map<string, string>();
    let concurrent = 0;
    let maxConcurrent = 0;
    for (const effect of timeline) {
      if (effect.kind === "start") {
        expect(running.has(effect.subjectId)).toBe(false);
        running.set(effect.subjectId, effect.operationId);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
      } else {
        expect(running.get(effect.subjectId)).toBe(effect.operationId);
        running.delete(effect.subjectId);
        concurrent -= 1;
      }
    }
    expect(timeline).toHaveLength(80);
    expect(operationIds).toHaveLength(40);
    report("R7 max concurrent subjects observed", maxConcurrent);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("R7 library groupConcurrency across two pg-boss instances (measured, not asserted)", async () => {
    const measured = await measureKeyOverlaps("r7-group", "group");
    report("R7 groupConcurrency:1 overlaps / fetch errors", measured);
  });

  it("R7 library singleton policy + singletonKey serializes a key across two pg-boss instances", async () => {
    const measured = await measureKeyOverlaps("r7-singleton", "singleton");
    report("R7 singleton policy overlaps / fetch errors", measured);
    expect(measured.overlaps).toBe(0);
  });

  it("R8 stop() lets the running operation finish and takes no new work", async () => {
    const api = await openRunner("r8", "api");
    const worker = await PgBossOperationRunner.open({ url, queue: "r8", role: "worker" });
    await worker.start(scenarioHandlers(worker.db).settle);
    const running = await accept(api, {});
    await waitFor(async () => (await effects(api.db, running.operationId)).includes("start"), 10_000);
    const stopStarted = Date.now();
    const stopping = worker.stop();
    await sleep(100);
    const later = await accept(api, {});
    await stopping;
    report("R8 stop duration ms", Date.now() - stopStarted);
    expect(await effects(api.db, running.operationId)).toEqual(["start", "end"]);
    expect((await operation(api.db, running.operationId))?.status).toBe("done");
    await sleep(2_000);
    expect((await operation(api.db, later.operationId))?.status).toBe("queued");
    expect(await effects(api.db, later.operationId)).toEqual([]);
  });

  it("R9 failure is visible on the row and the job, not retried, and replayable explicitly", async () => {
    const api = await openRunner("r9", "api");
    await openRunner("r9", "worker", "throw");
    const accepted = await accept(api, {});
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "failed", 10_000);
    const failedJob = await waitFor(async () => {
      const main = (await jobsFor(api.db, accepted.operationId)).find((job) => job.name === "r9");
      return main?.state === "failed" ? main : undefined;
    }, 10_000);
    report("R9 failed job output", failedJob.output);
    expect(JSON.stringify(failedJob.output)).toContain("boom in");
    await sleep(3_000);
    expect(await effects(api.db, accepted.operationId)).toEqual(["ran"]);
    await api.replay(accepted.operationId);
    await waitFor(async () => (await effects(api.db, accepted.operationId)).length === 2, 10_000);
    await waitFor(async () => (await operation(api.db, accepted.operationId))?.status === "failed", 10_000);
    expect((await operation(api.db, accepted.operationId))?.runs).toBe(2);
  });

  it("R3 runner persists only operationId/subjectId in job data", async () => {
    const api = await openRunner("r3", "api");
    const rows = await api.db.execute<{ name: string; data: Record<string, unknown> | null }>(
      sql`SELECT name, data FROM pgboss.job WHERE name NOT LIKE '__pgboss%' AND name NOT LIKE 'r7-%'`,
    );
    expect(rows.rows.length).toBeGreaterThan(50);
    const keySets = new Set(rows.rows.map((row) => Object.keys(row.data ?? {}).sort().join(",")));
    expect([...keySets]).toEqual(["operationId,subjectId"]);
    const tables = await api.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'pgboss' ORDER BY 1`,
    );
    const columns = await api.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'pgboss' AND table_name = 'job' ORDER BY ordinal_position`,
    );
    report("R3 pgboss tables", tables.rows.map((row) => row.table_name));
    report("R3 pgboss.job columns", columns.rows.map((row) => row.column_name));
    const latest = await api.db
      .select({ id: spikeOperations.id })
      .from(spikeOperations)
      .orderBy(desc(spikeOperations.createdAt))
      .limit(1);
    expect(latest).toHaveLength(1);
  });

  it("R10 schema can be owned by a migration: exported plans + migrate:false", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const plans = getConstructionPlans("pgboss_owned");
    await pool.query(plans);
    await pool.end();
    const boss = new PgBoss({
      connectionString: url,
      schema: "pgboss_owned",
      migrate: false,
      createSchema: false,
      schedule: false,
      supervise: false,
    });
    boss.on("error", () => undefined);
    await boss.start();
    try {
      expect(await boss.isInstalled()).toBe(true);
      await boss.createQueue("owned", { retryLimit: 0 });
      expect(await boss.send("owned", { operationId: "x" })).toBeTypeOf("string");
      const drift = await boss.detectSchemaDrift();
      report("R10 drift report keys", Object.keys(drift));
      report("R10 plan statements bytes", plans.length);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

async function measureKeyOverlaps(
  queue: string,
  mode: "group" | "singleton",
): Promise<{ overlaps: number; errors: number; jobs: number }> {
  let errors = 0;
  const instances = await Promise.all(
    [0, 1].map(async () => {
      const boss = new PgBoss({ connectionString: url, schedule: false, supervise: false });
      boss.on("error", () => {
        errors += 1;
      });
      await boss.start();
      return boss;
    }),
  );
  const [sender] = instances;
  if (!sender) {
    throw new TypeError("no pg-boss instance");
  }
  await sender.createQueue(queue, {
    retryLimit: 0,
    policy: mode === "singleton" ? "singleton" : "standard",
  });
  const intervals: { key: string; start: number; end: number }[] = [];
  for (const boss of instances) {
    await boss.work<{ key: string }>(
      queue,
      {
        localConcurrency: 4,
        pollingIntervalSeconds: 0.5,
        ...(mode === "group" ? { groupConcurrency: 1 } : {}),
      },
      async (jobs) => {
        for (const job of jobs) {
          const start = performance.now();
          await sleep(150);
          intervals.push({ key: job.data.key, start, end: performance.now() });
        }
      },
    );
  }
  const total = 24;
  for (let index = 0; index < total; index += 1) {
    const key = `k${index % 3}`;
    await sender.send(
      queue,
      { key },
      mode === "group" ? { group: { id: key } } : { singletonKey: key },
    );
  }
  try {
    await waitFor(async () => intervals.length === total, 90_000);
  } finally {
    await Promise.all(instances.map((boss) => boss.stop({ graceful: false })));
  }
  let overlaps = 0;
  for (const key of ["k0", "k1", "k2"]) {
    const sorted = intervals.filter((item) => item.key === key).sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index += 1) {
      if ((sorted[index]?.start ?? 0) < (sorted[index - 1]?.end ?? 0)) {
        overlaps += 1;
      }
    }
  }
  return { overlaps, errors, jobs: intervals.length };
}
