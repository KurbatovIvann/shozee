import { and, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { PgBoss, fromDrizzle } from "pg-boss";

import { connect, type SpikeDb, type SpikeTx } from "../shared/db.js";
import type {
  OperationHandler,
  OperationRef,
  OperationRunner,
  RunContext,
} from "../shared/port.js";
import { spikeOperations } from "../shared/schema.js";
import {
  expireWaitWithoutSignal,
  recordStep,
  registerWaitOrReadSignal,
  storeSignal,
} from "./wait.js";

export type PgqRunContext = RunContext & {
  readonly step: (
    key: string,
    effect: (tx: SpikeTx) => Promise<void>,
  ) => Promise<void>;
};

export type PgqHandler = (context: PgqRunContext) => Promise<void>;

export type PgqRunnerOptions = {
  readonly url: string;
  readonly queue: string;
  readonly role: "api" | "worker";
  readonly concurrency?: number;
  readonly schema?: string;
};

export class Suspended extends Error {
  constructor() {
    super("operation suspended until signal");
  }
}

export const PGBOSS_SCHEMA = "pgboss";

export class PgBossOperationRunner implements OperationRunner {
  private constructor(
    readonly boss: PgBoss,
    readonly db: SpikeDb,
    readonly pool: pg.Pool,
    private readonly options: PgqRunnerOptions,
  ) {}

  get queue(): string {
    return this.options.queue;
  }

  get deadlineQueue(): string {
    return `${this.options.queue}-deadline`;
  }

  get timeoutQueue(): string {
    return `${this.options.queue}-timeout`;
  }

  static async open(options: PgqRunnerOptions): Promise<PgBossOperationRunner> {
    const worker = options.role === "worker";
    const boss = new PgBoss({
      connectionString: options.url,
      schema: options.schema ?? PGBOSS_SCHEMA,
      useListenNotify: true,
      supervise: worker,
      schedule: false,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
    });
    boss.on("error", (error) => {
      process.stderr.write(`pg-boss error: ${String(error.message)}\n`);
    });
    await boss.start();
    const { db, pool } = connect(options.url);
    const runner = new PgBossOperationRunner(boss, db, pool, options);
    const queues = [
      { name: runner.queue, notify: true, policy: "singleton" },
      { name: runner.deadlineQueue, notify: false, policy: "standard" },
      { name: runner.timeoutQueue, notify: false, policy: "standard" },
    ];
    for (const { name, notify, policy } of queues) {
      if (!(await boss.getQueue(name))) {
        await boss.createQueue(name, { retryLimit: 0, notify, policy });
      }
    }
    return runner;
  }

  async enqueue(tx: SpikeTx, operation: OperationRef): Promise<void> {
    const seconds = await this.sendOperation(tx, operation);
    await this.boss.send(this.deadlineQueue, identity(operation), {
      db: fromDrizzle(tx, sql),
      startAfter: seconds,
      retryLimit: 0,
    });
  }

  async start(handler: PgqHandler | OperationHandler): Promise<void> {
    await this.boss.work<OperationRef>(
      this.queue,
      {
        localConcurrency: this.options.concurrency ?? 1,
        pollingIntervalSeconds: 0.5,
        notifyPollingIntervalSeconds: 5,
      },
      async (jobs) => {
        for (const job of jobs) {
          await this.runOperation(job.data, handler);
        }
      },
    );
    await this.boss.work<OperationRef>(
      this.deadlineQueue,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await this.interruptIfOverdue(job.data.operationId);
        }
      },
    );
    await this.boss.work<OperationRef>(
      this.timeoutQueue,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await expireWaitWithoutSignal(this.db, job.data.operationId);
        }
      },
    );
  }

  async signal(operationId: string, name: string, payload: unknown): Promise<void> {
    await this.db.transaction(async (tx) => {
      const resume = await storeSignal(tx, operationId, name, payload);
      if (resume) {
        await this.sendOperation(tx, resume);
      }
    });
  }

  async replay(operationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(spikeOperations)
        .set({
          status: "queued",
          deadlineAt: sql`now() + (${spikeOperations.deadlineAt} - ${spikeOperations.createdAt})`,
          revision: sql`${spikeOperations.revision} + 1`,
        })
        .where(
          and(eq(spikeOperations.id, operationId), eq(spikeOperations.status, "failed")),
        )
        .returning({ id: spikeOperations.id, subjectId: spikeOperations.subjectId });
      if (!row) {
        throw new ReplayRefused(operationId);
      }
      await this.enqueue(tx, { operationId: row.id, subjectId: row.subjectId });
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    await this.pool.end();
  }

  private async sendOperation(tx: SpikeTx, operation: OperationRef): Promise<number> {
    const [row] = await tx
      .select({
        seconds: sql<number>`greatest(1, ceil(extract(epoch from ${spikeOperations.deadlineAt} - now())))::int`,
      })
      .from(spikeOperations)
      .where(eq(spikeOperations.id, operation.operationId));
    const seconds = row?.seconds ?? 1;
    await this.boss.send(this.queue, identity(operation), {
      db: fromDrizzle(tx, sql),
      singletonKey: operation.subjectId,
      retryLimit: 0,
      expireInSeconds: seconds,
    });
    return seconds;
  }

  private async runOperation(
    operation: OperationRef,
    handler: PgqHandler | OperationHandler,
  ): Promise<void> {
    const claimed = await this.db
      .update(spikeOperations)
      .set({
        status: "running",
        runs: sql`CASE WHEN ${spikeOperations.status} = 'queued' THEN ${spikeOperations.runs} + 1 ELSE ${spikeOperations.runs} END`,
        revision: sql`${spikeOperations.revision} + 1`,
      })
      .where(
        and(
          eq(spikeOperations.id, operation.operationId),
          inArray(spikeOperations.status, ["queued", "waiting"]),
          sql`${spikeOperations.deadlineAt} > now()`,
        ),
      )
      .returning({ id: spikeOperations.id });
    if (!claimed[0]) {
      return;
    }
    const context: PgqRunContext = {
      operationId: operation.operationId,
      waitForSignal: (name, timeoutMs) => this.waitForSignal(operation, name, timeoutMs),
      step: (key, effect) => recordStep(this.db, operation.operationId, key, effect),
    };
    try {
      await handler(context);
    } catch (error) {
      if (error instanceof Suspended) {
        return;
      }
      await this.finish(operation.operationId, "failed");
      throw error;
    }
    await this.finish(operation.operationId, "done");
  }

  private async waitForSignal(
    operation: OperationRef,
    name: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const outcome = await this.db.transaction(async (tx) => {
      const found = await registerWaitOrReadSignal(tx, operation.operationId, name, timeoutMs);
      if (found) {
        return found;
      }
      await this.boss.send(this.timeoutQueue, identity(operation), {
        db: fromDrizzle(tx, sql),
        startAfter: Math.ceil(timeoutMs / 1000),
        retryLimit: 0,
      });
      return null;
    });
    if (!outcome) {
      throw new Suspended();
    }
    return outcome.payload;
  }

  private async finish(operationId: string, status: "done" | "failed"): Promise<void> {
    await this.db
      .update(spikeOperations)
      .set({ status, revision: sql`${spikeOperations.revision} + 1` })
      .where(and(eq(spikeOperations.id, operationId), eq(spikeOperations.status, "running")));
  }

  private async interruptIfOverdue(operationId: string): Promise<void> {
    await this.db
      .update(spikeOperations)
      .set({ status: "interrupted", revision: sql`${spikeOperations.revision} + 1` })
      .where(
        and(
          eq(spikeOperations.id, operationId),
          inArray(spikeOperations.status, ["queued", "running"]),
          sql`${spikeOperations.deadlineAt} <= now()`,
        ),
      );
  }
}

export class ReplayRefused extends Error {
  constructor(operationId: string) {
    super(`operation ${operationId} is not failed`);
  }
}

function identity(operation: OperationRef): OperationRef {
  return { operationId: operation.operationId, subjectId: operation.subjectId };
}
