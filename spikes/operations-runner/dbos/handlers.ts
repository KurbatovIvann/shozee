import { setTimeout as sleep } from "node:timers/promises";

import type { SpikeDb } from "../shared/db.js";
import { spikeEffects } from "../shared/schema.js";
import type { DbosOperationHandler } from "./runner.js";

export type Scenario = "basic" | "slow" | "wait" | "concurrent" | "throws" | "drain";

export class HandlerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandlerFailure";
  }
}

export function isScenario(value: string | undefined): value is Scenario {
  return (
    value === "basic" ||
    value === "slow" ||
    value === "wait" ||
    value === "concurrent" ||
    value === "throws" ||
    value === "drain"
  );
}

export function handlerFor(scenario: Scenario, db: SpikeDb): DbosOperationHandler {
  const effect = async (operationId: string, kind: string): Promise<void> => {
    await db.insert(spikeEffects).values({ operationId, kind });
  };
  switch (scenario) {
    case "basic":
      return async (ctx) => {
        await ctx.step("run", () => effect(ctx.operationId, "run"));
      };
    case "slow":
      return async (ctx) => {
        await ctx.step("start", () => effect(ctx.operationId, "start"));
        await ctx.step("work", async () => {
          await sleep(6_000);
          await effect(ctx.operationId, "end");
        });
      };
    case "drain":
      return async (ctx) => {
        await ctx.step("start", () => effect(ctx.operationId, "start"));
        await ctx.step("work", async () => {
          await sleep(2_000);
          await effect(ctx.operationId, "end");
        });
      };
    case "wait":
      return async (ctx) => {
        await ctx.step("before", () => effect(ctx.operationId, "before"));
        const answer = await ctx.waitForSignal("answer", 10_000);
        if (answer === null) {
          throw new HandlerFailure("answer timed out");
        }
        await ctx.step("after", () => effect(ctx.operationId, `after:${JSON.stringify(answer)}`));
      };
    case "concurrent":
      return async (ctx) => {
        await ctx.step("start", () => effect(ctx.operationId, "start"));
        await ctx.step("work", () => sleep(150));
        await ctx.step("end", () => effect(ctx.operationId, "end"));
      };
    case "throws":
      return async (ctx) => {
        await ctx.step("attempt", () => effect(ctx.operationId, "attempt"));
        throw new HandlerFailure("handler exploded");
      };
  }
}
