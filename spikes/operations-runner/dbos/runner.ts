import { DBOS, DBOSClient, WorkflowQueue } from "@dbos-inc/dbos-sdk";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import pg from "pg";

import { connect, type SpikeDb, type SpikeTx } from "../shared/db.js";
import type { OperationRef, RunContext } from "../shared/port.js";
import { spikeOperations } from "../shared/schema.js";

export const APP_NAME = "spike";
export const APP_VERSION = "spike-v1";
export const QUEUE_NAME = "operations";
export const WORKFLOW_NAME = "operation";

export type DbosRunContext = RunContext & {
  readonly step: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export type DbosOperationHandler = (context: DbosRunContext) => Promise<void>;

export type DbosRunnerOptions = {
  readonly databaseUrl: string;
  readonly executorId?: string;
  readonly workerConcurrency?: number;
  readonly drainTimeoutMs?: number;
  readonly guardRecoveredAttempts?: boolean;
};

export class OperationInterrupted extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} interrupted`);
    this.name = "OperationInterrupted";
  }
}

type Guarded<T> = { readonly live: true; readonly value: T } | { readonly live: false };

type OperationWorkflow = (ref: OperationRef) => Promise<void>;

export function pgClientOf(tx: SpikeTx): pg.ClientBase {
  const session: unknown = Reflect.get(tx, "session");
  const client: unknown =
    typeof session === "object" && session !== null ? Reflect.get(session, "client") : undefined;
  if (client instanceof pg.Client) {
    return client;
  }
  throw new TypeError("drizzle transaction is not bound to a pg client");
}

export class DbosOperationRunner {
  private client: DBOSClient | undefined;
  private readonly liveAttempts = new Set<string>();
  private readonly db: SpikeDb;
  private readonly pool: pg.Pool;

  constructor(private readonly options: DbosRunnerOptions) {
    const connection = connect(options.databaseUrl);
    this.db = connection.db;
    this.pool = connection.pool;
  }

  async enqueue(tx: SpikeTx, operation: OperationRef): Promise<void> {
    const client = await this.dbosClient();
    await client.enqueueInTransaction<OperationWorkflow>(
      pgClientOf(tx),
      {
        queueName: QUEUE_NAME,
        workflowName: WORKFLOW_NAME,
        workflowID: operation.operationId,
        queuePartitionKey: operation.subjectId,
        appVersion: APP_VERSION,
        applicationName: APP_NAME,
      },
      { operationId: operation.operationId, subjectId: operation.subjectId },
    );
  }

  async start(handler: DbosOperationHandler): Promise<void> {
    new WorkflowQueue(QUEUE_NAME, {
      workerConcurrency: this.options.workerConcurrency ?? 4,
      partitionConcurrency: 1,
      minPollingIntervalMs: 200,
    });
    DBOS.registerWorkflow(
      (ref: OperationRef) => this.runOperation(handler, ref),
      { name: WORKFLOW_NAME },
    );
    DBOS.setConfig({
      name: APP_NAME,
      applicationVersion: APP_VERSION,
      executorID: this.options.executorId ?? "local",
      systemDatabaseUrl: this.options.databaseUrl,
      runMigrations: false,
      logLevel: "warn",
    });
    await DBOS.launch();
  }

  async signal(operationId: string, name: string, payload: unknown): Promise<void> {
    const client = await this.dbosClient();
    await client.send(operationId, payload, name, `${operationId}:${name}`);
  }

  async stop(): Promise<void> {
    if (DBOS.isInitialized()) {
      await DBOS.shutdown({ workflowCompletionTimeoutMS: this.options.drainTimeoutMs ?? 30_000 });
    }
    await this.client?.destroy();
    this.client = undefined;
    await this.pool.end();
  }

  async sweep(): Promise<string[]> {
    const expired = await this.db
      .update(spikeOperations)
      .set({ status: "interrupted", revision: sql`${spikeOperations.revision} + 1` })
      .where(
        and(
          inArray(spikeOperations.status, ["running", "waiting"]),
          lt(spikeOperations.deadlineAt, sql`now()`),
        ),
      )
      .returning({ id: spikeOperations.id });
    const ids = expired.map((row) => row.id);
    if (ids.length > 0) {
      const client = await this.dbosClient();
      await client.cancelWorkflows(ids);
    }
    return ids;
  }

  async replay(operationId: string): Promise<string> {
    const reset = await this.db
      .update(spikeOperations)
      .set({ status: "queued", revision: sql`${spikeOperations.revision} + 1` })
      .where(and(eq(spikeOperations.id, operationId), inArray(spikeOperations.status, ["failed", "interrupted"])))
      .returning({ subjectId: spikeOperations.subjectId });
    const row = reset[0];
    if (row === undefined) {
      throw new TypeError(`operation ${operationId} is not replayable`);
    }
    const client = await this.dbosClient();
    return client.forkWorkflow(operationId, 0, {
      applicationVersion: APP_VERSION,
      queueName: QUEUE_NAME,
      queuePartitionKey: row.subjectId,
    });
  }

  private async dbosClient(): Promise<DBOSClient> {
    this.client ??= await DBOSClient.create({
      systemDatabaseUrl: this.options.databaseUrl,
      applicationName: APP_NAME,
    });
    return this.client;
  }

  private async runOperation(handler: DbosOperationHandler, ref: OperationRef): Promise<void> {
    const operationId = ref.operationId;
    const claimed = await DBOS.runStep(() => this.claim(operationId), { name: "claim" });
    if (!claimed) {
      return;
    }
    const context: DbosRunContext = {
      operationId,
      step: (name, fn) => this.guardedStep(operationId, name, fn),
      waitForSignal: (name, timeoutMs) => this.waitForSignal(operationId, name, timeoutMs),
    };
    try {
      await handler(context);
      await DBOS.runStep(() => this.moveFrom(operationId, ["running"], "done"), { name: "finish" });
    } catch (error) {
      if (error instanceof OperationInterrupted) {
        return;
      }
      await DBOS.runStep(() => this.moveFrom(operationId, ["running", "waiting"], "failed"), {
        name: "fail",
      });
      throw error;
    }
  }

  private async claim(operationId: string): Promise<boolean> {
    const rows = await this.db
      .update(spikeOperations)
      .set({
        status: "running",
        runs: sql`${spikeOperations.runs} + 1`,
        revision: sql`${spikeOperations.revision} + 1`,
      })
      .where(and(eq(spikeOperations.id, operationId), eq(spikeOperations.status, "queued")))
      .returning({ id: spikeOperations.id });
    if (rows.length === 0) {
      return false;
    }
    this.liveAttempts.add(operationId);
    return true;
  }

  private async guardedStep<T>(operationId: string, name: string, fn: () => Promise<T>): Promise<T> {
    const outcome = await DBOS.runStep(
      async (): Promise<Guarded<T>> => {
        if (this.options.guardRecoveredAttempts !== false && !this.liveAttempts.has(operationId)) {
          return { live: false };
        }
        return { live: true, value: await fn() };
      },
      { name },
    );
    if (!outcome.live) {
      await this.interrupt(operationId);
    }
    if (outcome.live) {
      return outcome.value;
    }
    throw new OperationInterrupted(operationId);
  }

  private async waitForSignal(operationId: string, name: string, timeoutMs: number): Promise<unknown> {
    await this.guardedStep(operationId, `wait:${name}:begin`, () =>
      this.moveFrom(operationId, ["running"], "waiting"),
    );
    const payload = await DBOS.recv<unknown>(name, { timeoutSeconds: timeoutMs / 1000 });
    const resumed = await DBOS.runStep(
      async () => {
        const moved = await this.moveFrom(operationId, ["waiting"], "running");
        if (moved) {
          this.liveAttempts.add(operationId);
        }
        return moved;
      },
      { name: `wait:${name}:end` },
    );
    if (!resumed) {
      throw new OperationInterrupted(operationId);
    }
    return payload;
  }

  private async interrupt(operationId: string): Promise<void> {
    await DBOS.runStep(() => this.moveFrom(operationId, ["running", "waiting"], "interrupted"), {
      name: "interrupt",
    });
  }

  private async moveFrom(
    operationId: string,
    from: ReadonlyArray<"running" | "waiting">,
    to: "running" | "waiting" | "done" | "failed" | "interrupted",
  ): Promise<boolean> {
    const rows = await this.db
      .update(spikeOperations)
      .set({ status: to, revision: sql`${spikeOperations.revision} + 1` })
      .where(and(eq(spikeOperations.id, operationId), inArray(spikeOperations.status, [...from])))
      .returning({ id: spikeOperations.id });
    return rows.length > 0;
  }
}
