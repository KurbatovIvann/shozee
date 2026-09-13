import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

describe("dbos R4-R5", () => {
  let harness: Harness;
  const workers: Worker[] = [];

  const spawnWorker = async (...args: Parameters<typeof startWorker> extends [string, ...infer Rest] ? Rest : never) => {
    const worker = await startWorker(harness.url, ...args);
    workers.push(worker);
    return worker;
  };

  const waitForEffect = (operationId: string, kind: string) =>
    waitUntil(async () => (await effectKinds(harness.db, operationId)).includes(kind), 20_000, kind);

  beforeAll(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.child.exitCode === null) {
        await worker.kill();
      }
    }
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("R4 DBOS re-dispatches a killed run on restart and the attempt guard marks it interrupted", async () => {
    const ref = newRef();
    await accept(harness, ref, { deadlineMs: 60_000 });
    const first = await spawnWorker("slow", "r4-guard");
    await waitForEffect(ref.operationId, "start");
    await first.kill();
    expect((await operationRow(harness.db, ref.operationId))?.status).toBe("running");

    await spawnWorker("slow", "r4-guard");
    const row = await waitForStatus(harness.db, ref.operationId, "interrupted");
    expect(row.runs).toBe(1);
    const workflow = await waitUntil(async () => {
      const current = await dbosWorkflow(harness.db, ref.operationId);
      return current?.status === "SUCCESS" ? current : undefined;
    });
    expect(Number(workflow.recovery_attempts)).toBeGreaterThanOrEqual(2);
    await sleep(7_000);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["start"]);
    expect((await operationRow(harness.db, ref.operationId))?.runs).toBe(1);
  });

  it("R4 control: without the guard DBOS re-executes the unfinished step after restart", async () => {
    const ref = newRef();
    await accept(harness, ref, { deadlineMs: 60_000 });
    const first = await spawnWorker("slow", "r4-control", { DBOS_SPIKE_UNGUARDED: "1" });
    await waitForEffect(ref.operationId, "start");
    await first.kill();

    await spawnWorker("slow", "r4-control", { DBOS_SPIKE_UNGUARDED: "1" });
    const row = await waitForStatus(harness.db, ref.operationId, "done", 20_000);
    expect(row.runs).toBe(1);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["start", "end"]);
    expect(Number((await dbosWorkflow(harness.db, ref.operationId))?.recovery_attempts)).toBeGreaterThanOrEqual(2);
  });

  it("R4 hazard: a second live worker sharing an executor id recovers the first one's in-flight run", async () => {
    const ref = newRef();
    await accept(harness, ref, { deadlineMs: 60_000 });
    await spawnWorker("slow", "r4-shared");
    await waitForEffect(ref.operationId, "start");
    await spawnWorker("slow", "r4-shared");
    await sleep(14_000);
    const row = await operationRow(harness.db, ref.operationId);
    const workflow = await dbosWorkflow(harness.db, ref.operationId);
    console.info(
      "R4 shared executor",
      JSON.stringify({
        status: row?.status,
        runs: row?.runs,
        effects: await effectKinds(harness.db, ref.operationId),
        wf: workflow?.status,
        attempts: workflow?.recovery_attempts,
        executor: workflow?.executor_id,
      }),
    );
    expect(row?.runs).toBe(1);
    expect(Number(workflow?.recovery_attempts)).toBeGreaterThanOrEqual(2);
  });

  it("R4 a worker that never returns: deadline sweep interrupts and cancels, restart does not run it", async () => {
    const ref = newRef();
    await accept(harness, ref, { deadlineMs: 3_000 });
    const acceptedAt = Date.now();
    const doomed = await spawnWorker("slow", "r4-dead");
    await waitForEffect(ref.operationId, "start");
    await doomed.kill();

    await spawnWorker("slow", "r4-sweeper", { DBOS_SPIKE_SWEEP_MS: "1000" });
    await waitForStatus(harness.db, ref.operationId, "interrupted", 15_000);
    const interruptedAfterMs = Date.now() - acceptedAt;
    expect((await dbosWorkflow(harness.db, ref.operationId))?.status).toBe("CANCELLED");

    await spawnWorker("slow", "r4-dead");
    await sleep(8_000);
    const row = await operationRow(harness.db, ref.operationId);
    expect(row?.status).toBe("interrupted");
    expect(row?.runs).toBe(1);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["start"]);
    expect((await dbosWorkflow(harness.db, ref.operationId))?.status).toBe("CANCELLED");
    console.info(`R4 sweep interrupted after ${interruptedAfterMs} ms (deadline 3000 + sweep 1000)`);
  });

  it("R5 wait survives SIGKILL: restart, then signal resumes without repeating effects", async () => {
    const ref = newRef();
    await accept(harness, ref);
    const first = await spawnWorker("wait", "r5-resume");
    await waitForStatus(harness.db, ref.operationId, "waiting");
    await first.kill();

    await spawnWorker("wait", "r5-resume");
    await sleep(1_500);
    expect((await operationRow(harness.db, ref.operationId))?.status).toBe("waiting");
    await harness.runner.signal(ref.operationId, "answer", { answer: 42 });
    const row = await waitForStatus(harness.db, ref.operationId, "done");
    expect(row.runs).toBe(1);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["before", 'after:{"answer":42}']);
  });

  it("R5 signal sent while no worker is alive is delivered after restart", async () => {
    const ref = newRef();
    await accept(harness, ref);
    const first = await spawnWorker("wait", "r5-offline");
    await waitForStatus(harness.db, ref.operationId, "waiting");
    await first.kill();
    await harness.runner.signal(ref.operationId, "answer", "late");

    await spawnWorker("wait", "r5-offline");
    await waitForStatus(harness.db, ref.operationId, "done");
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["before", 'after:"late"']);
  });

  it("R5 no signal: durable timeout across a restart fails the operation", async () => {
    const ref = newRef();
    await accept(harness, ref);
    const first = await spawnWorker("wait", "r5-timeout");
    await waitForStatus(harness.db, ref.operationId, "waiting");
    const waitingAt = Date.now();
    await first.kill();
    await sleep(2_000);

    await spawnWorker("wait", "r5-timeout");
    await waitForStatus(harness.db, ref.operationId, "failed", 20_000);
    const elapsed = Date.now() - waitingAt;
    expect(elapsed).toBeLessThan(14_000);
    expect(await effectKinds(harness.db, ref.operationId)).toEqual(["before"]);
    expect((await dbosWorkflow(harness.db, ref.operationId))?.status).toBe("ERROR");
    console.info(`R5 timeout fired ${elapsed} ms after waiting (timeout 10000, restart gap 2000)`);
  });
});
