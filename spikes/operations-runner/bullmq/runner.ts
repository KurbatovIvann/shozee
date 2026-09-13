import { DelayedError, Queue, Worker, type Job } from "bullmq";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import type { SpikeDb, SpikeTx } from "../shared/db.js";
import type {
  OperationRef,
  OperationRunner,
  RunContext,
} from "../shared/port.js";
import { spikeEffects, spikeOperations } from "../shared/schema.js";
import { bullmqSteps, bullmqWaits } from "./schema.js";

export const PREFIX = "spike-bullmq";
export const REDIS_CONNECTION = {
  host: "127.0.0.1",
  port: 56379,
  maxRetriesPerRequest: null,
};

export type StepContext = RunContext & {
  readonly step: (
    key: string,
    effect: (tx: SpikeTx) => Promise<void>,
  ) => Promise<void>;
};

export type BullmqHandler = (context: StepContext) => Promise<void>;

export type JobData = { operationId: string; subjectId: string };

export type RunnerOptions = {
  readonly db: SpikeDb;
  readonly queueName: string;
  readonly claimGuard: boolean;
  readonly concurrency?: number;
  readonly maxStalledCount?: number;
  readonly lockDuration?: number;
  readonly stalledInterval?: number;
};

class ParkForSignal extends Error {
  constructor(
    readonly signalName: string,
    readonly delayMs: number,
  ) {
    super(`parked on ${signalName}`);
  }
}

function lockOperation(tx: SpikeTx, operationId: string) {
  return tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`,
  );
}

export class BullmqOperationRunner implements OperationRunner {
  readonly queue: Queue<JobData>;
  private worker: Worker<JobData> | null = null;
  private handler: BullmqHandler | null = null;

  constructor(private readonly options: RunnerOptions) {
    this.queue = new Queue<JobData>(options.queueName, {
      connection: REDIS_CONNECTION,
      prefix: PREFIX,
    });
  }

  async enqueue(tx: SpikeTx, operation: OperationRef): Promise<void> {
    if (this.options.claimGuard) {
      await lockOperation(tx, operation.operationId);
    }
    await this.queue.add(
      "operation",
      { operationId: operation.operationId, subjectId: operation.subjectId },
      { jobId: operation.operationId, attempts: 1 },
    );
  }

  async start(handler: BullmqHandler): Promise<void> {
    this.handler = handler;
    const worker = new Worker<JobData>(
      this.options.queueName,
      (job, token) => this.process(job, token),
      {
        connection: REDIS_CONNECTION,
        prefix: PREFIX,
        concurrency: this.options.concurrency ?? 1,
        maxStalledCount: this.options.maxStalledCount ?? 0,
        lockDuration: this.options.lockDuration ?? 30_000,
        stalledInterval: this.options.stalledInterval ?? 30_000,
      },
    );
    worker.on("error", () => undefined);
    await worker.waitUntilReady();
    this.worker = worker;
  }

  async signal(
    operationId: string,
    name: string,
    payload: unknown,
  ): Promise<void> {
    await this.options.db
      .insert(bullmqWaits)
      .values({
        operationId,
        name,
        timeoutAt: sql`now()`,
        payload,
        signaledAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [bullmqWaits.operationId, bullmqWaits.name],
        set: { payload, signaledAt: sql`now()` },
        setWhere: isNull(bullmqWaits.signaledAt),
      });
    await this.wake(operationId);
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.queue.close();
  }

  async retryFailed(operationId: string): Promise<boolean> {
    const reset = await this.options.db
      .update(spikeOperations)
      .set({
        status: "queued",
        revision: sql`${spikeOperations.revision} + 1`,
        deadlineAt: sql`now() + interval '60 seconds'`,
      })
      .where(
        and(
          eq(spikeOperations.id, operationId),
          eq(spikeOperations.status, "failed"),
        ),
      )
      .returning({ id: spikeOperations.id });
    if (reset.length === 0) {
      return false;
    }
    const job = await this.queue.getJob(operationId);
    if (!job) {
      return false;
    }
    await job.retry("failed");
    return true;
  }

  private async wake(operationId: string): Promise<void> {
    const job = await this.queue.getJob(operationId);
    if (job && (await job.isDelayed())) {
      await job.promote().catch(() => undefined);
    }
  }

  private async process(job: Job<JobData>, token?: string): Promise<void> {
    const { db } = this.options;
    const { operationId } = job.data;
    await db
      .insert(spikeEffects)
      .values({ operationId, kind: `delivery:${process.pid}` });
    const claimed = this.options.claimGuard
      ? await this.claim(operationId)
      : true;
    if (!claimed || !this.handler) {
      return;
    }
    try {
      await this.handler(this.context(operationId));
      await this.finish(operationId, "done");
    } catch (error) {
      if (error instanceof ParkForSignal) {
        await job.moveToDelayed(Date.now() + error.delayMs, token);
        if (await this.isSignaled(operationId, error.signalName)) {
          await job.promote().catch(() => undefined);
        }
        throw new DelayedError();
      }
      await this.finish(operationId, "failed");
      throw error;
    }
  }

  private async finish(
    operationId: string,
    status: "done" | "failed",
  ): Promise<void> {
    await this.options.db
      .update(spikeOperations)
      .set({ status, revision: sql`${spikeOperations.revision} + 1` })
      .where(
        and(
          eq(spikeOperations.id, operationId),
          eq(spikeOperations.status, "running"),
        ),
      );
  }

  private claim(operationId: string): Promise<boolean> {
    return this.options.db.transaction(async (tx) => {
      await lockOperation(tx, operationId);
      const [row] = await tx
        .select({ status: spikeOperations.status })
        .from(spikeOperations)
        .where(eq(spikeOperations.id, operationId))
        .for("update");
      if (!row || (row.status !== "queued" && row.status !== "waiting")) {
        return false;
      }
      await tx
        .update(spikeOperations)
        .set({
          status: "running",
          runs:
            row.status === "queued"
              ? sql`${spikeOperations.runs} + 1`
              : spikeOperations.runs,
          revision: sql`${spikeOperations.revision} + 1`,
        })
        .where(eq(spikeOperations.id, operationId));
      return true;
    });
  }

  private async isSignaled(operationId: string, name: string) {
    const [row] = await this.options.db
      .select({ signaledAt: bullmqWaits.signaledAt })
      .from(bullmqWaits)
      .where(
        and(eq(bullmqWaits.operationId, operationId), eq(bullmqWaits.name, name)),
      );
    return row?.signaledAt != null;
  }

  private context(operationId: string): StepContext {
    const { db } = this.options;
    return {
      operationId,
      step: async (key, effect) => {
        await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(bullmqSteps)
            .values({ operationId, key })
            .onConflictDoNothing()
            .returning({ key: bullmqSteps.key });
          if (inserted.length > 0) {
            await effect(tx);
          }
        });
      },
      waitForSignal: async (name, timeoutMs) => {
        const [existing] = await db
          .select({
            payload: bullmqWaits.payload,
            signaledAt: bullmqWaits.signaledAt,
            due: sql<boolean>`${bullmqWaits.timeoutAt} <= now()`,
            remainingMs: sql<number>`greatest(0, extract(epoch from (${bullmqWaits.timeoutAt} - now())) * 1000)::float8`,
          })
          .from(bullmqWaits)
          .where(
            and(
              eq(bullmqWaits.operationId, operationId),
              eq(bullmqWaits.name, name),
            ),
          );
        if (existing?.signaledAt != null) {
          return existing.payload;
        }
        if (existing?.due) {
          return null;
        }
        await db.transaction(async (tx) => {
          if (!existing) {
            await tx.insert(bullmqWaits).values({
              operationId,
              name,
              timeoutAt: sql`now() + ${timeoutMs} * interval '1 millisecond'`,
            });
          }
          await tx
            .update(spikeOperations)
            .set({
              status: "waiting",
              revision: sql`${spikeOperations.revision} + 1`,
            })
            .where(
              and(
                eq(spikeOperations.id, operationId),
                eq(spikeOperations.status, "running"),
              ),
            );
        });
        throw new ParkForSignal(name, existing?.remainingMs ?? timeoutMs);
      },
    };
  }
}

export async function sweepDeadlines(db: SpikeDb): Promise<string[]> {
  const swept = await db
    .update(spikeOperations)
    .set({
      status: "interrupted",
      revision: sql`${spikeOperations.revision} + 1`,
    })
    .where(
      and(
        inArray(spikeOperations.status, ["queued", "running", "waiting"]),
        lt(spikeOperations.deadlineAt, sql`now()`),
      ),
    )
    .returning({ id: spikeOperations.id });
  return swept.map((row) => row.id);
}
