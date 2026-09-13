import type { SpikeTx } from "./db.js";

export type OperationRef = {
  readonly operationId: string;
  readonly subjectId: string;
};

export type RunContext = {
  readonly operationId: string;
  readonly waitForSignal: (
    name: string,
    timeoutMs: number,
  ) => Promise<unknown | null>;
};

export type OperationHandler = (context: RunContext) => Promise<void>;

export interface OperationRunner {
  enqueue(tx: SpikeTx, operation: OperationRef): Promise<void>;
  start(handler: OperationHandler): Promise<void>;
  signal(operationId: string, name: string, payload: unknown): Promise<void>;
  stop(): Promise<void>;
}
