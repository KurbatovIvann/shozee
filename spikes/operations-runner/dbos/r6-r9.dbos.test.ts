import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { spikeOperations } from "../shared/schema.js";
import {
  accept,
  dbosWorkflow,
  effectKinds,
  newRef,
  operationRow,
  setupHarness,
  startWorker,
  waitForStatus,
  waitUntil,
  type Harness,
  type Worker,
} from "./harness.js";

type SnapshotRow = { id: string; status: string; wf_status: string | null };

describe("dbos R6-R9", () => {
  let harness: Harness;
  const workers: Worker[] = [];

  const spawnWorker = async (...args: Parameters<typeof startWorker> extends [string, ...infer Rest] ? Rest : never) => {
    const worker = await startWorker(harness.url, ...args);
    workers.push(worker);
    return worker;
  };

  beforeAll(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.child.exitCode === null) {
        await worker.kill();
      }
    }
    await harness.db.delete(spikeOperations);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("R6 one REPEATABLE READ snapshot sees the row and the DBOS workflow agree (100 iterations)", async () => {
    await spawnWorker("basic", "r6");
    const violations: string[] = [];
    let observed = 0;
    const writer = async () => {
      for (let index = 0; index < 100; index += 1) {
        await accept(harness, newRef());
      }
    };
    const reader = async () => {
      for (let index = 0; index < 100; index += 1) {
        const rows = await harness.db.transaction(
          async (tx) => {
            const result = await tx.execute<SnapshotRow>(sql`
              SELECT o.id::text AS id, o.status, w.status AS wf_status
              FROM spike_operations o
              FULL JOIN dbos.workflow_status w ON w.workflow_uuid = o.id::text
              WHERE o.id IS NOT NULL OR w.queue_name = 'operations'`);
            return result.rows;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
        for (const row of rows) {
          observed += 1;
          const ok =
            (row.status === "queued" && (row.wf_status === "ENQUEUED" || row.wf_status === "PENDING")) ||
            (row.status === "running" && row.wf_status === "PENDING") ||
            (row.status === "done" && (row.wf_status === "PENDING" || row.wf_status === "SUCCESS"));
          if (!ok) violations.push(`${row.id}:${row.status}/${String(row.wf_status)}`);
        }
      }
    };
    await Promise.all([writer(), reader()]);
    expect(observed).toBeGreaterThan(100);
    expect(violations).toEqual([]);
  });

  it("R7 two workers, concurrency 4, 40 operations over 10 subjects: no per-subject overlap", async () => {
    await spawnWorker("concurrent", "r7-a");
    await spawnWorker("concurrent", "r7-b");
    const subjects = Array.from({ length: 10 }, () => randomUUID());
    const refs = Array.from({ length: 40 }, (_, index) => newRef(subjects[index % 10]));
    await Promise.all(refs.map((ref) => accept(harness, ref, { rowSubjectId: randomUUID() })));

    await waitUntil(
      async () => {
        const result = await harness.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM spike_operations WHERE status = 'done'`,
        );
        return result.rows[0]?.n === "40";
      },
      60_000,
      "40 done",
    );

    const spans = await harness.db.execute<{ operation_id: string; started: string; ended: string; executor: string }>(sql`
      SELECT s.operation_id::text AS operation_id,
             (extract(epoch FROM s.created_at) * 1000000)::bigint::text AS started,
             (extract(epoch FROM e.created_at) * 1000000)::bigint::text AS ended,
             w.executor_id AS executor
      FROM spike_effects s
      JOIN spike_effects e ON e.operation_id = s.operation_id AND e.kind = 'end'
      JOIN dbos.workflow_status w ON w.workflow_uuid = s.operation_id::text
      WHERE s.kind = 'start'`);
    expect(spans.rows).toHaveLength(40);
    const subjectOf = new Map(refs.map((ref) => [ref.operationId, ref.subjectId]));
    const overlaps: string[] = [];
    for (const subject of subjects) {
      const mine = spans.rows
        .filter((span) => subjectOf.get(span.operation_id) === subject)
        .map((span) => ({ start: BigInt(span.started), end: BigInt(span.ended) }))
        .sort((left, right) => (left.start < right.start ? -1 : 1));
      for (let index = 1; index < mine.length; index += 1) {
        const previous = mine[index - 1];
        const current = mine[index];
        if (previous !== undefined && current !== undefined && current.start < previous.end) {
          overlaps.push(subject);
        }
      }
    }
    expect(overlaps).toEqual([]);
    const byExecutor = new Map<string, number>();
    for (const span of spans.rows) byExecutor.set(span.executor, (byExecutor.get(span.executor) ?? 0) + 1);
    expect([...byExecutor.keys()].sort()).toEqual(["r7-a", "r7-b"]);
    let peak = 0;
    const edges = spans.rows.flatMap((span) => [
      { at: BigInt(span.started), delta: 1 },
      { at: BigInt(span.ended), delta: -1 },
    ]);
    edges.sort((left, right) => (left.at === right.at ? left.delta - right.delta : left.at < right.at ? -1 : 1));
    let running = 0;
    for (const edge of edges) {
      running += edge.delta;
      peak = Math.max(peak, running);
    }
    console.info(`R7 per executor ${JSON.stringify([...byExecutor])}, peak concurrent ${peak}`);
  });

  it("R8 stop lets the in-flight run finish and takes no new work", async () => {
    const worker = await spawnWorker("drain", "r8");
    const inFlight = newRef();
    await accept(harness, inFlight);
    await waitUntil(async () => (await effectKinds(harness.db, inFlight.operationId)).includes("start"));
    const stopping = worker.stop();
    await sleep(300);
    const late = newRef();
    await accept(harness, late);
    const elapsed = await stopping;

    const flightRow = await operationRow(harness.db, inFlight.operationId);
    console.info(
      `R8 stop took ${elapsed} ms; in-flight ${flightRow?.status} effects ${JSON.stringify(await effectKinds(harness.db, inFlight.operationId))} wf ${(await dbosWorkflow(harness.db, inFlight.operationId))?.status}`,
    );
    expect(await effectKinds(harness.db, inFlight.operationId)).toEqual(["start", "end"]);
    expect(flightRow?.status).toBe("done");
    await sleep(2_000);
    expect((await operationRow(harness.db, late.operationId))?.status).toBe("queued");
    expect((await dbosWorkflow(harness.db, late.operationId))?.status).toBe("ENQUEUED");

    await spawnWorker("drain", "r8-next");
    await waitForStatus(harness.db, late.operationId, "done");
  });

  it("R9 a throwing handler is visible as failed/ERROR, not retried, and can be replayed explicitly", async () => {
    await spawnWorker("throws", "r9");
    const ref = newRef();
    await accept(harness, ref);
    await waitForStatus(harness.db, ref.operationId, "failed");
    await sleep(3_000);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["attempt"]);
    const workflow = await dbosWorkflow(harness.db, ref.operationId);
    expect(workflow?.status).toBe("ERROR");
    expect(workflow?.error).toContain("handler exploded");
    const steps = await harness.db.execute<{ function_name: string; error: string | null }>(
      sql`SELECT function_name, error FROM dbos.operation_outputs WHERE workflow_uuid = ${ref.operationId} ORDER BY function_id`,
    );
    expect(steps.rows.map((step) => step.function_name)).toEqual(["claim", "attempt", "fail"]);

    const forkedId = await harness.runner.replay(ref.operationId);
    expect(forkedId).not.toBe(ref.operationId);
    const replayed = await waitForStatus(harness.db, ref.operationId, "failed");
    expect(replayed.runs).toBe(2);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["attempt", "attempt"]);
    expect((await dbosWorkflow(harness.db, forkedId))?.status).toBe("ERROR");
  });
});
