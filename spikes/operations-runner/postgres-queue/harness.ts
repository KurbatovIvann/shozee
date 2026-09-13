import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { asc, eq, sql } from "drizzle-orm";

import { connect, freshDatabase, type SpikeDb } from "../shared/db.js";
import { spikeEffects, spikeOperations } from "../shared/schema.js";
import type { ScenarioName } from "./handlers.js";
import { PGBOSS_SCHEMA, type PgBossOperationRunner } from "./runner.js";
import { installCompensationTables } from "./schema.js";

export const DATABASE = "spike_pgq";
const spikeRoot = fileURLToPath(new URL("..", import.meta.url));

export async function setupDatabase(): Promise<string> {
  const url = await freshDatabase(DATABASE);
  const { db, pool } = connect(url);
  await installCompensationTables(db);
  await pool.end();
  return url;
}

export type Accepted = { operationId: string; subjectId: string };

export async function accept(
  runner: PgBossOperationRunner,
  input: { commandId?: string; subjectId?: string; deadlineMs?: number; rollback?: boolean },
): Promise<Accepted> {
  const commandId = input.commandId ?? randomUUID();
  const subjectId = input.subjectId ?? randomUUID();
  const deadlineSeconds = (input.deadlineMs ?? 60_000) / 1000;
  const operationId = randomUUID();
  const rollback = new RollbackRequested();
  try {
    return await runner.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(spikeOperations)
        .values({
          id: operationId,
          subjectId,
          commandId,
          status: "queued",
          deadlineAt: sql`now() + make_interval(secs => ${deadlineSeconds})`,
        })
        .onConflictDoNothing({ target: spikeOperations.commandId })
        .returning({ id: spikeOperations.id });
      if (!inserted[0]) {
        const [existing] = await tx
          .select({ id: spikeOperations.id, subjectId: spikeOperations.subjectId })
          .from(spikeOperations)
          .where(eq(spikeOperations.commandId, commandId));
        if (!existing) {
          throw new RollbackRequested();
        }
        return { operationId: existing.id, subjectId: existing.subjectId };
      }
      await runner.enqueue(tx, { operationId, subjectId });
      if (input.rollback) {
        throw rollback;
      }
      return { operationId, subjectId };
    });
  } catch (error) {
    if (error === rollback) {
      return { operationId, subjectId };
    }
    throw error;
  }
}

class RollbackRequested extends Error {
  constructor() {
    super("rollback requested");
  }
}

export async function operation(db: SpikeDb, operationId: string) {
  const [row] = await db
    .select()
    .from(spikeOperations)
    .where(eq(spikeOperations.id, operationId));
  return row;
}

export async function effects(db: SpikeDb, operationId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: spikeEffects.kind })
    .from(spikeEffects)
    .where(eq(spikeEffects.operationId, operationId))
    .orderBy(asc(spikeEffects.id));
  return rows.map((row) => row.kind);
}

export type JobRow = { name: string; state: string; data: unknown; output: unknown };

export async function jobsFor(db: SpikeDb, operationId: string): Promise<JobRow[]> {
  const result = await db.execute<JobRow>(
    sql`SELECT name, state, data, output FROM ${sql.identifier(PGBOSS_SCHEMA)}.job WHERE data->>'operationId' = ${operationId} ORDER BY created_on`,
  );
  return result.rows;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new WaitTimedOut(timeoutMs);
    }
    await sleep(intervalMs);
  }
}

class WaitTimedOut extends Error {
  constructor(timeoutMs: number) {
    super(`condition not met within ${timeoutMs}ms`);
  }
}

export type SpawnedWorker = { child: ChildProcess; ready: Promise<void>; output: () => string };

export function spawnWorker(input: {
  url: string;
  queue: string;
  handler: ScenarioName;
  concurrency?: number;
}): SpawnedWorker {
  const child = spawn(process.execPath, ["--import", "tsx", "postgres-queue/worker.ts"], {
    cwd: spikeRoot,
    env: {
      ...process.env,
      PGQ_URL: input.url,
      PGQ_QUEUE: input.queue,
      PGQ_HANDLER: input.handler,
      PGQ_CONCURRENCY: String(input.concurrency ?? 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes("ready")) {
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.on("exit", (code) => reject(new WorkerExited(code, log)));
  });
  return { child, ready, output: () => log };
}

class WorkerExited extends Error {
  constructor(code: number | null, log: string) {
    super(`worker exited with ${String(code)}: ${log}`);
  }
}

export async function killWorker(worker: SpawnedWorker): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));
  worker.child.kill("SIGKILL");
  await exited;
}
