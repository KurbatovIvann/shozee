import { EMPTY_STAFF_ASSISTANT_TURN_USAGE } from "@showzy/ai";
import { describe, expect, it } from "vitest";

import type { EvalTurnResult } from "./run-turn.js";
import { runEvalScenario } from "./run-eval.js";
import {
  evalRunIsGreen,
  formatEvalReport,
  verdictForPassRate,
} from "./reporter.js";
import type { EvalScenario } from "./scenario.js";

const usage = EMPTY_STAFF_ASSISTANT_TURN_USAGE;

function result(passedTrace: boolean): EvalTurnResult {
  return {
    trace: {
      text: passedTrace ? "3" : "nope",
      toolCalls: passedTrace
        ? [
            {
              toolCallId: "c1",
              name: "orders_list_counts",
              args: { period: "today" },
            },
          ]
        : [{ toolCallId: "c1", name: "orders_list_page", args: {} }],
    },
    usage,
    gateUsage: usage,
    estimatedCostUsd: 0.001,
    replyModelId: "mock-sonnet",
    gateModelId: "mock-haiku",
  };
}

const scenario: EvalScenario = {
  id: "proof.orders-counts-today",
  description: "counts",
  fixture: "proof",
  turns: [{ text: "скільки замовлень сьогодні" }],
  expectation: {
    ordered: [{ name: "orders_list_counts", args: { period: "today" } }],
  },
};

describe("verdictForPassRate", () => {
  it("treats 3/3 as pass, 0/3 as fail, and 2/3 as flake", () => {
    expect(verdictForPassRate(3, 3)).toBe("pass");
    expect(verdictForPassRate(0, 3)).toBe("fail");
    expect(verdictForPassRate(2, 3)).toBe("flake");
    expect(verdictForPassRate(1, 3)).toBe("flake");
  });
});

describe("runEvalScenario", () => {
  it("counts pass rate without retrying", async () => {
    const outcomes = [true, true, false];
    let index = 0;
    const report = await runEvalScenario({
      scenario,
      runs: 3,
      runOnce: () => {
        const passed = outcomes[index] === true;
        index += 1;
        return Promise.resolve(result(passed));
      },
    });
    expect(report.passed).toBe(2);
    expect(report.runs).toBe(3);
    expect(report.verdict).toBe("flake");
    expect(evalRunIsGreen([report])).toBe(false);
    const formatted = formatEvalReport({
      green: false,
      estimatedCostUsd: report.estimatedCostUsd,
      scenarios: [report],
    });
    expect(formatted).toContain("flake");
    expect(formatted).toContain("2/3");
    expect(formatted).toContain("orders_list_page");
    expect(formatted).toContain('text "nope"');
    expect(formatted).not.toContain("sk-ant");
    expect(formatted).not.toContain("You are");
  });

  it("is green only when every run passes", async () => {
    const report = await runEvalScenario({
      scenario,
      runs: 3,
      runOnce: () => Promise.resolve(result(true)),
    });
    expect(report.verdict).toBe("pass");
    expect(evalRunIsGreen([report])).toBe(true);
  });
});
