import type { StaffAssistantTurnUsage } from "@showzy/ai";

import type { EvalMatchResult, EvalTurnTrace } from "./expectation.js";

export type EvalScenarioVerdict = "pass" | "fail" | "flake";

export interface EvalScenarioRun {
  readonly index: number;
  readonly passed: boolean;
  readonly match: EvalMatchResult;
  readonly trace: EvalTurnTrace;
  readonly usage: StaffAssistantTurnUsage;
  readonly gateUsage: StaffAssistantTurnUsage;
  readonly estimatedCostUsd: number;
}

export interface EvalScenarioReport {
  readonly scenarioId: string;
  readonly runs: number;
  readonly passed: number;
  readonly verdict: EvalScenarioVerdict;
  readonly estimatedCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly gateInputTokens: number;
  readonly gateOutputTokens: number;
  readonly details: readonly EvalScenarioRun[];
}

export interface EvalRunReport {
  readonly green: boolean;
  readonly estimatedCostUsd: number;
  readonly scenarios: readonly EvalScenarioReport[];
}

/**
 * Whole-run green only when every scenario passed every attempt.
 * 2/3 is flake, not green. 0/N is fail.
 */
export function verdictForPassRate(
  passed: number,
  runs: number,
): EvalScenarioVerdict {
  if (runs < 1) {
    return "fail";
  }
  if (passed === runs) {
    return "pass";
  }
  if (passed === 0) {
    return "fail";
  }
  return "flake";
}

export function evalRunIsGreen(
  reports: readonly EvalScenarioReport[],
): boolean {
  return reports.every((report) => report.verdict === "pass");
}

const TEXT_PREVIEW_CHARS = 200;

function formatTextPreview(text: string): string {
  const clipped =
    text.length > TEXT_PREVIEW_CHARS
      ? `${text.slice(0, TEXT_PREVIEW_CHARS)}…`
      : text;
  return `    text ${JSON.stringify(clipped)}`;
}

function formatToolCalls(trace: EvalTurnTrace): string {
  if (trace.toolCalls.length === 0) {
    return "    (no tool calls)";
  }
  return trace.toolCalls
    .map((call) => {
      const args = JSON.stringify(call.args);
      return `    - ${call.name} ${args}`;
    })
    .join("\n");
}

export function formatEvalReport(report: EvalRunReport): string {
  const lines: string[] = [
    `ai-eval ${report.green ? "GREEN" : "NOT GREEN"}  estimated_usd=${report.estimatedCostUsd.toFixed(6)}`,
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `  ${scenario.scenarioId}  ${scenario.verdict}  ${String(scenario.passed)}/${String(scenario.runs)}  usd=${scenario.estimatedCostUsd.toFixed(6)}  in=${String(scenario.inputTokens)} out=${String(scenario.outputTokens)} cache_r=${String(scenario.cacheReadTokens)} cache_w=${String(scenario.cacheWriteTokens)} gate_in=${String(scenario.gateInputTokens)} gate_out=${String(scenario.gateOutputTokens)}`,
    );
    for (const detail of scenario.details) {
      const reason = detail.match.ok ? "ok" : detail.match.reason;
      lines.push(`    run ${String(detail.index + 1)}: ${reason}`);
      lines.push(formatTextPreview(detail.trace.text));
      lines.push(formatToolCalls(detail.trace));
    }
  }
  return lines.join("\n");
}

export function aggregateEvalRun(
  scenarios: readonly EvalScenarioReport[],
): EvalRunReport {
  let estimatedCostUsd = 0;
  for (const scenario of scenarios) {
    estimatedCostUsd += scenario.estimatedCostUsd;
  }
  return {
    green: evalRunIsGreen(scenarios),
    estimatedCostUsd,
    scenarios,
  };
}
