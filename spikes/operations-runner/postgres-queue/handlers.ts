import { setTimeout as sleep } from "node:timers/promises";

import type { SpikeDb, SpikeTx } from "../shared/db.js";
import { spikeEffects } from "../shared/schema.js";
import type { PgqHandler } from "./runner.js";

export const scenarioNames = ["quick", "slow", "settle", "overlap", "wait", "throw"] as const;
export type ScenarioName = (typeof scenarioNames)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return scenarioNames.some((name) => name === value);
}

export class HandlerBoom extends Error {
  constructor(operationId: string) {
    super(`boom in ${operationId}`);
  }
}

export function scenarioHandlers(db: SpikeDb): Record<ScenarioName, PgqHandler> {
  const record = async (
    executor: SpikeDb | SpikeTx,
    operationId: string,
    kind: string,
  ): Promise<void> => {
    await executor.insert(spikeEffects).values({ operationId, kind });
  };
  return {
    quick: async ({ operationId }) => {
      await record(db, operationId, "ran");
    },
    slow: async ({ operationId }) => {
      await record(db, operationId, "start");
      await sleep(30_000);
      await record(db, operationId, "end");
    },
    settle: async ({ operationId }) => {
      await record(db, operationId, "start");
      await sleep(1_500);
      await record(db, operationId, "end");
    },
    overlap: async ({ operationId }) => {
      await record(db, operationId, "start");
      await sleep(50 + Math.floor(Math.random() * 150));
      await record(db, operationId, "end");
    },
    wait: async ({ operationId, step, waitForSignal }) => {
      await record(db, operationId, "invoked");
      await step("before", (tx) => record(tx, operationId, "before"));
      const payload = await waitForSignal("answer", 10_000);
      await record(db, operationId, `after:${JSON.stringify(payload)}`);
    },
    throw: async ({ operationId }) => {
      await record(db, operationId, "ran");
      throw new HandlerBoom(operationId);
    },
  };
}
