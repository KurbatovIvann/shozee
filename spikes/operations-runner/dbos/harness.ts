import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { eq, sql } from "drizzle-orm";

import { connect, freshDatabase, type SpikeDb } from "../shared/db.js";
import type { OperationRef } from "../shared/port.js";
import { spikeEffects, spikeOperations } from "../shared/schema.js";
import type { Scenario } from "./handlers.js";
import { DbosOperationRunner } from "./runner.js";

export const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DBOS_CLI = resolve(SPIKE_ROOT, "node_modules/@dbos-inc/dbos-sdk/dist/src/cli/cli.js");

export type Harness = {
  readonly url: string;
  readonly db: SpikeDb;
  readonly runner: DbosOperationRunner;
  readonly close: () => Promise<void>;
};

export async function setupHarness(): Promise<Harness> {
  const url = await freshDatabase("spike_dbos");
  await promisify(execFile)(process.execPath, [DBOS_CLI, "schema", url]);
  const { db, pool } = connect(url);
  const runner = new DbosOperationRunner({ databaseUrl: url });
  return {
    url,
    db,
    runner,
    close: async () => {
      await runner.stop();
      await pool.end();
    },
  };
}

export type Worker = {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly stop: () => Promise<number>;
  readonly kill: () => Promise<void>;
};

export async function startWorker(
  url: string,
  scenario: Scenario,
  executorId: string,
  extraEnv: Record<string, string> = {},
): Promise<Worker> {
  const child = spawn(process.execPath, ["--import", "tsx", "dbos/worker.ts"], {
    cwd: SPIKE_ROOT,
    env: {
      ...process.env,
      DBOS_SPIKE_URL: url,
      DBOS_SPIKE_SCENARIO: scenario,
      DBOS_SPIKE_EXECUTOR: executorId,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  await new Promise<void>((resolveReady, rejectReady) => {
    child.on("message", (message: unknown) => {
      if (message === "ready") resolveReady();
    });
    child.once("exit", (code) => rejectReady(new Error(`worker exited ${String(code)}: ${log}`)));
  });
  return {
    child,
    output: () => log,
    stop: async () => {
      const stopped = new Promise<number>((resolveStopped) => {
        child.on("message", (message: unknown) => {
          if (typeof message === "object" && message !== null && "stopped" in message) {
            resolveStopped(Number(message.stopped));
          }
        });
      });
      child.send("stop");
      const elapsed = await stopped;
      await exited;
      return elapsed;
    },
    kill: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

export function newRef(subjectId: string = randomUUID()): OperationRef {
  return { operationId: randomUUID(), subjectId };
}

export async function accept(
  harness: Harness,
  ref: OperationRef,
  options: { commandId?: string; deadlineMs?: number; rollback?: boolean; rowSubjectId?: string } = {},
): Promise<boolean> {
  const rollback = new Error("rollback");
  try {
    return await harness.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(spikeOperations)
        .values({
          id: ref.operationId,
          subjectId: options.rowSubjectId ?? ref.subjectId,
          commandId: options.commandId ?? randomUUID(),
          status: "queued",
          deadlineAt: sql`now() + ${`${options.deadlineMs ?? 60_000} milliseconds`}::interval`,
        })
        .onConflictDoNothing({ target: spikeOperations.commandId })
        .returning({ id: spikeOperations.id });
      if (inserted.length === 0) {
        return false;
      }
      await harness.runner.enqueue(tx, ref);
      if (options.rollback === true) {
        throw rollback;
      }
      return true;
    });
  } catch (error) {
    if (error === rollback) {
      return false;
    }
    throw error;
  }
}

export async function operationRow(db: SpikeDb, operationId: string) {
  const rows = await db.select().from(spikeOperations).where(eq(spikeOperations.id, operationId));
  return rows[0];
}

export async function effectKinds(db: SpikeDb, operationId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: spikeEffects.kind })
    .from(spikeEffects)
    .where(eq(spikeEffects.operationId, operationId))
    .orderBy(spikeEffects.id);
  return rows.map((row) => row.kind);
}

export async function waitUntil<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function waitForStatus(db: SpikeDb, operationId: string, status: string, timeoutMs = 20_000) {
  return waitUntil(
    async () => {
      const row = await operationRow(db, operationId);
      return row?.status === status ? row : undefined;
    },
    timeoutMs,
    `${operationId} -> ${status}`,
  );
}

export type DbosWorkflowRow = {
  readonly workflow_uuid: string;
  readonly status: string;
  readonly executor_id: string | null;
  readonly recovery_attempts: string | null;
  readonly inputs: string | null;
  readonly error: string | null;
  readonly queue_partition_key: string | null;
};

export async function dbosWorkflow(db: SpikeDb, operationId: string): Promise<DbosWorkflowRow | undefined> {
  const result = await db.execute<DbosWorkflowRow>(
    sql`SELECT workflow_uuid, status, executor_id, recovery_attempts::text, inputs, error, queue_partition_key
        FROM dbos.workflow_status WHERE workflow_uuid = ${operationId}`,
  );
  return result.rows[0];
}
