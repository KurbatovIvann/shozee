import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TransactionRollbackError, and, eq, like, sql } from "drizzle-orm";

import type { SpikeDb } from "../shared/db.js";
import { spikeEffects, spikeOperations } from "../shared/schema.js";
import type { BullmqHandler, BullmqOperationRunner } from "./runner.js";

export const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return check();
}

export type AcceptInput = {
  readonly subjectId: string;
  readonly commandId?: string;
  readonly deadlineMs?: number;
  readonly beforeCommit?: () => Promise<void>;
  readonly rollback?: boolean;
};

export type AcceptResult = { operationId: string; created: boolean };

export async function accept(
  db: SpikeDb,
  runner: BullmqOperationRunner,
  input: AcceptInput,
): Promise<AcceptResult> {
  const operationId = randomUUID();
  const commandId = input.commandId ?? randomUUID();
  const deadlineMs = input.deadlineMs ?? 60_000;
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(spikeOperations)
        .values({
          id: operationId,
          subjectId: input.subjectId,
          commandId,
          status: "queued",
          deadlineAt: sql`now() + ${deadlineMs} * interval '1 millisecond'`,
        })
        .onConflictDoNothing({ target: spikeOperations.commandId })
        .returning({ id: spikeOperations.id });
      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ id: spikeOperations.id })
          .from(spikeOperations)
          .where(eq(spikeOperations.commandId, commandId));
        return { operationId: existing?.id ?? operationId, created: false };
      }
      await runner.enqueue(tx, { operationId, subjectId: input.subjectId });
      await input.beforeCommit?.();
      if (input.rollback) {
        tx.rollback();
      }
      return { operationId, created: true };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return { operationId, created: false };
    }
    throw error;
  }
}

export function pgErrorField(
  error: unknown,
  field: "code" | "constraint",
): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (field in current) {
      const value: unknown = Reflect.get(current, field);
      if (typeof value === "string") {
        return value;
      }
    }
    current = current.cause;
  }
  return undefined;
}

export async function operation(db: SpikeDb, operationId: string) {
  const [row] = await db
    .select()
    .from(spikeOperations)
    .where(eq(spikeOperations.id, operationId));
  return row;
}

export async function effectCount(
  db: SpikeDb,
  operationId: string,
  kind: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spikeEffects)
    .where(
      and(eq(spikeEffects.operationId, operationId), like(spikeEffects.kind, kind)),
    );
  return rows[0]?.n ?? 0;
}

export async function recordEffect(
  db: SpikeDb,
  operationId: string,
  kind: string,
): Promise<void> {
  await db.insert(spikeEffects).values({ operationId, kind });
}

export class SignalTimeoutError extends Error {}

export function workHandler(db: SpikeDb, workMs: number): BullmqHandler {
  return async (context) => {
    await recordEffect(db, context.operationId, "start");
    await sleep(workMs);
    await recordEffect(db, context.operationId, "end");
  };
}

export function waitHandler(db: SpikeDb, waitMs: number): BullmqHandler {
  return async (context) => {
    await recordEffect(db, context.operationId, "invocation");
    await context.step("before-wait", async (tx) => {
      await tx
        .insert(spikeEffects)
        .values({ operationId: context.operationId, kind: "before-wait" });
    });
    const answer = await context.waitForSignal("answer", waitMs);
    if (answer === null) {
      throw new SignalTimeoutError("answer timed out");
    }
    await context.step("after-wait", async (tx) => {
      await tx.insert(spikeEffects).values({
        operationId: context.operationId,
        kind: `after-wait:${JSON.stringify(answer)}`,
      });
    });
  };
}

export type WorkerEnv = {
  readonly databaseUrl: string;
  readonly queueName: string;
  readonly scenario: "work" | "wait";
  readonly workMs?: number;
  readonly waitMs?: number;
  readonly concurrency?: number;
  readonly maxStalledCount?: number;
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
};

export type SpawnedWorker = {
  readonly child: ChildProcess;
  readonly kill: () => Promise<void>;
  readonly exited: Promise<number | null>;
};

export function spawnWorker(env: WorkerEnv): Promise<SpawnedWorker> {
  const child = spawn(process.execPath, ["--import", "tsx", "bullmq/worker.ts"], {
    cwd: SPIKE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SPIKE_DB_URL: env.databaseUrl,
      SPIKE_QUEUE: env.queueName,
      SPIKE_SCENARIO: env.scenario,
      SPIKE_WORK_MS: String(env.workMs ?? 0),
      SPIKE_WAIT_MS: String(env.waitMs ?? 10_000),
      SPIKE_CONCURRENCY: String(env.concurrency ?? 1),
      SPIKE_MAX_STALLED: String(env.maxStalledCount ?? 0),
      SPIKE_LOCK_MS: String(env.lockDurationMs ?? 30_000),
      SPIKE_STALLED_MS: String(env.stalledIntervalMs ?? 30_000),
    },
  });
  const exited = new Promise<number | null>((done) => {
    child.on("exit", (code) => done(code));
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((ready, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`worker not ready: ${stderr}`)),
      30_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        clearTimeout(timer);
        ready({
          child,
          exited,
          kill: async () => {
            child.kill("SIGKILL");
            await exited;
          },
        });
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      fail(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}
