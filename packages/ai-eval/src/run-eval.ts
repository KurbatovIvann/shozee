import { matchEvalExpectation } from "./expectation.js";
import {
  aggregateEvalRun,
  verdictForPassRate,
  type EvalRunReport,
  type EvalScenarioReport,
  type EvalScenarioRun,
} from "./reporter.js";
import type { EvalTurnResult } from "./run-turn.js";
import type { EvalScenario } from "./scenario.js";

export async function runEvalScenario(options: {
  readonly scenario: EvalScenario;
  readonly runs: number;
  readonly runOnce: () => Promise<EvalTurnResult>;
}): Promise<EvalScenarioReport> {
  const details: EvalScenarioRun[] = [];
  let passed = 0;
  let estimatedCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let gateInputTokens = 0;
  let gateOutputTokens = 0;

  for (let index = 0; index < options.runs; index += 1) {
    const result = await options.runOnce();
    const match = matchEvalExpectation(
      options.scenario.expectation,
      result.trace,
    );
    if (match.ok) {
      passed += 1;
    }
    estimatedCostUsd += result.estimatedCostUsd;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cacheReadTokens += result.usage.cacheReadTokens;
    cacheWriteTokens += result.usage.cacheWriteTokens;
    gateInputTokens += result.gateUsage.inputTokens;
    gateOutputTokens += result.gateUsage.outputTokens;
    details.push({
      index,
      passed: match.ok,
      match,
      trace: result.trace,
      usage: result.usage,
      gateUsage: result.gateUsage,
      estimatedCostUsd: result.estimatedCostUsd,
    });
  }

  return {
    scenarioId: options.scenario.id,
    runs: options.runs,
    passed,
    verdict: verdictForPassRate(passed, options.runs),
    estimatedCostUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    gateInputTokens,
    gateOutputTokens,
    details,
  };
}

export async function runEvalSuite(options: {
  readonly scenarios: readonly EvalScenario[];
  readonly runs: number;
  readonly runOnce: (scenario: EvalScenario) => Promise<EvalTurnResult>;
}): Promise<EvalRunReport> {
  const reports: EvalScenarioReport[] = [];
  for (const scenario of options.scenarios) {
    reports.push(
      await runEvalScenario({
        scenario,
        runs: options.runs,
        runOnce: () => options.runOnce(scenario),
      }),
    );
  }
  return aggregateEvalRun(reports);
}
