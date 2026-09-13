import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  accept,
  dbosWorkflow,
  effectKinds,
  newRef,
  operationRow,
  setupHarness,
  startWorker,
  waitForStatus,
  type Harness,
  type Worker,
} from "./harness.js";

describe("dbos R1-R3", () => {
  let harness: Harness;
  let worker: Worker;

  beforeAll(async () => {
    harness = await setupHarness();
    worker = await startWorker(harness.url, "basic", "worker-a");
  });

  afterAll(async () => {
    await worker?.stop();
    await harness?.close();
  });

  it("R1 rollback leaves neither row nor workflow, commit runs", async () => {
    const rolledBack = newRef();
    expect(await accept(harness, rolledBack, { rollback: true })).toBe(false);
    await sleep(3_000);
    expect(await operationRow(harness.db, rolledBack.operationId)).toBeUndefined();
    expect(await dbosWorkflow(harness.db, rolledBack.operationId)).toBeUndefined();
    expect(await effectKinds(harness.db, rolledBack.operationId)).toEqual([]);

    const committed = newRef();
    expect(await accept(harness, committed)).toBe(true);
    const row = await waitForStatus(harness.db, committed.operationId, "done");
    expect(row.runs).toBe(1);
    expect(await effectKinds(harness.db, committed.operationId)).toEqual(["run"]);
    expect((await dbosWorkflow(harness.db, committed.operationId))?.status).toBe("SUCCESS");
  });

  it("R1 system tables live in schema dbos of the application database", async () => {
    const result = await harness.db.execute<{ table_schema: string; table_catalog: string; n: string }>(
      sql`SELECT table_schema, table_catalog, count(*)::text AS n FROM information_schema.tables
          WHERE table_schema = 'dbos' GROUP BY table_schema, table_catalog`,
    );
    expect(result.rows).toEqual([{ table_schema: "dbos", table_catalog: "spike_dbos", n: expect.any(String) }]);
  });

  it("R2 same command twice gives one row and one run", async () => {
    const commandId = randomUUID();
    const ref = newRef();
    expect(await accept(harness, ref, { commandId })).toBe(true);
    expect(await accept(harness, { ...ref, operationId: randomUUID() }, { commandId })).toBe(false);
    await waitForStatus(harness.db, ref.operationId, "done");
    const rows = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM spike_operations WHERE command_id = ${commandId}`,
    );
    expect(rows.rows[0]?.n).toBe("1");
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["run"]);
  });

  it("R2 second active command for a subject is refused by the database", async () => {
    const subjectId = randomUUID();
    const first = newRef(subjectId);
    const second = newRef(subjectId);
    const other = newRef();
    await harness.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO spike_operations (id, subject_id, command_id, status)
        VALUES (${first.operationId}, ${subjectId}, ${randomUUID()}, 'running')`);
    });
    await expect(accept(harness, second)).rejects.toThrow();
    expect(await dbosWorkflow(harness.db, second.operationId)).toBeUndefined();
    expect(await accept(harness, other)).toBe(true);
    await waitForStatus(harness.db, other.operationId, "done");
  });

  it("R3 runner persists only operationId and subjectId", async () => {
    const ref = newRef();
    await accept(harness, ref);
    await waitForStatus(harness.db, ref.operationId, "done");
    const workflow = await dbosWorkflow(harness.db, ref.operationId);
    expect(workflow?.inputs).not.toBeNull();
    const inputs: unknown = JSON.parse(workflow?.inputs ?? "null");
    expect(JSON.stringify(inputs)).toContain(ref.operationId);
    expect(JSON.stringify(inputs)).toContain(ref.subjectId);
    const payloadKeys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (key !== "__dbos_serializer" && key !== "json") payloadKeys.add(key);
          collect(inner);
        }
      }
    };
    collect(inputs);
    expect([...payloadKeys].sort()).toEqual(["operationId", "subjectId"]);
    const outputs = await harness.db.execute<{ function_name: string; output: string | null }>(
      sql`SELECT function_name, output FROM dbos.operation_outputs WHERE workflow_uuid = ${ref.operationId} ORDER BY function_id`,
    );
    expect(outputs.rows.map((row) => row.function_name)).toEqual(["claim", "run", "finish"]);
    console.info("R3 inputs", workflow?.inputs, "outputs", JSON.stringify(outputs.rows));
  });
});
