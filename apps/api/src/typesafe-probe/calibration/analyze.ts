import {
  decideStaffPlan,
  judgmentThresholdsOf,
  type JudgmentAnswer,
  type StaffJudgmentDecision,
  type StaffJudgmentSpec,
} from "@showzy/ai";

import { foldText, scoreCall } from "../followup/score.js";
import type { CalibrationCase } from "./case.js";

export interface CalibrationAnswerRow {
  readonly caseId: string;
  readonly refusal?: string;
  readonly answers?: Readonly<Record<string, JudgmentAnswer>>;
  readonly latencyMs: number;
  readonly inputTokens: number;
}

export interface CalibrationRun {
  readonly model: string;
  readonly rows: readonly CalibrationAnswerRow[];
}

export type CalibrationOutcome = "correct" | "wrong" | "delegated";

export interface CalibrationVerdict {
  readonly outcome: CalibrationOutcome;
  readonly tool?: string;
  readonly reason?: string;
  readonly decision?: StaffJudgmentDecision;
  readonly nameAsStored?: boolean;
}

export type SpecThresholds = NonNullable<StaffJudgmentSpec["thresholds"]>;
export type ThresholdsByTool = Readonly<Record<string, SpecThresholds>>;

const NEVER_A_WRITE = (): boolean => false;

export function withThresholds(
  specs: readonly StaffJudgmentSpec[],
  byTool: ThresholdsByTool,
): StaffJudgmentSpec[] {
  return specs.map((spec) => {
    const thresholds = byTool[spec.tool];
    return thresholds === undefined ? spec : { ...spec, thresholds };
  });
}

export function verdictOf(
  probeCase: CalibrationCase,
  row: CalibrationAnswerRow | undefined,
  specs: readonly StaffJudgmentSpec[],
): CalibrationVerdict {
  if (row?.answers === undefined) {
    return { outcome: "delegated", reason: row?.refusal ?? "missing" };
  }
  const decision = decideStaffPlan({
    message: probeCase.message,
    answers: row.answers,
    specs,
    isWrite: NEVER_A_WRITE,
  });
  if (decision.call === undefined || decision.declinedBecause !== undefined) {
    return {
      outcome: "delegated",
      reason: decision.declinedBecause ?? "no_call",
      decision,
    };
  }
  const score = scoreCall(probeCase, {
    tool: decision.call.tool,
    args: decision.call.args,
  });
  const name = decision.call.args["name"];
  const storedNames = [probeCase.expected, ...(probeCase.alsoOk ?? [])].flatMap(
    (call) => {
      const expectedName = call?.args["name"];
      return typeof expectedName === "string" ? [foldText(expectedName)] : [];
    },
  );
  return {
    outcome: score.correct ? "correct" : "wrong",
    tool: decision.call.tool,
    decision,
    ...(score.correct && typeof name === "string"
      ? { nameAsStored: storedNames.includes(foldText(name)) }
      : {}),
  };
}

export interface Tally {
  correct: number;
  wrong: number;
  delegated: number;
}

const emptyTally = (): Tally => ({ correct: 0, wrong: 0, delegated: 0 });

export function tallyBy(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
  keyOf: (probeCase: CalibrationCase, verdict: CalibrationVerdict) => string,
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const run of runs) {
    const rows = new Map(run.rows.map((row) => [row.caseId, row]));
    for (const probeCase of cases) {
      const verdict = verdictOf(probeCase, rows.get(probeCase.id), specs);
      const key = keyOf(probeCase, verdict);
      const tally = tallies.get(key) ?? emptyTally();
      tally[verdict.outcome] += 1;
      tallies.set(key, tally);
    }
  }
  return tallies;
}

export const ACT_GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98] as const;
export const ARGUMENT_GRID = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

export interface SweepPoint {
  readonly thresholds: Required<SpecThresholds>;
  readonly tune: Tally;
  readonly holdout: Tally;
}

export function sweepSpec(
  tool: string,
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
): SweepPoint[] {
  const base = specs.find((spec) => spec.tool === tool);
  if (base === undefined) {
    return [];
  }
  const defaults = judgmentThresholdsOf(base);
  return ACT_GRID.flatMap((act) =>
    ARGUMENT_GRID.map((argument) => {
      const thresholds = {
        take: Math.min(defaults.take, act),
        act,
        argument,
      };
      const tallies = tallyBy(
        cases,
        runs,
        withThresholds(specs, { [tool]: thresholds }),
        (probeCase, verdict) =>
          verdict.tool === tool ? probeCase.split : "elsewhere",
      );
      return {
        thresholds,
        tune: tallies.get("tune") ?? emptyTally(),
        holdout: tallies.get("holdout") ?? emptyTally(),
      };
    }),
  );
}

export function chooseThresholds(
  points: readonly SweepPoint[],
  wrongAllowed = 0,
): SweepPoint | undefined {
  const safe = points.filter((point) => point.tune.wrong <= wrongAllowed);
  const pool =
    safe.length > 0
      ? safe
      : points.filter(
          (point) =>
            point.tune.wrong ===
            Math.min(...points.map((other) => other.tune.wrong)),
        );
  return pool.toSorted(
    (a, b) =>
      b.tune.correct - a.tune.correct ||
      b.thresholds.act - a.thresholds.act ||
      b.thresholds.argument - a.thresholds.argument,
  )[0];
}

export function wilsonUpper(wrong: number, total: number): number {
  if (total === 0) {
    return Number.NaN;
  }
  const z = 1.96;
  const share = wrong / total;
  const centre = share + (z * z) / (2 * total);
  const spread =
    z * Math.sqrt((share * (1 - share)) / total + (z * z) / (4 * total ** 2));
  return Math.min(1, (centre + spread) / (1 + (z * z) / total));
}

export const RELIABILITY_EDGES = [
  0, 0.1, 0.3, 0.5, 0.7, 0.85, 0.95, 1,
] as const;

export interface ReliabilityBin {
  readonly from: number;
  readonly to: number;
  total: number;
  positive: number;
}

function binsOf(
  points: readonly { readonly value: number; readonly positive: boolean }[],
): ReliabilityBin[] {
  const bins: ReliabilityBin[] = RELIABILITY_EDGES.slice(0, -1).map(
    (from, index) => ({
      from,
      to: RELIABILITY_EDGES[index + 1] ?? 1,
      total: 0,
      positive: 0,
    }),
  );
  for (const point of points) {
    const bin =
      bins.find(
        (entry) => point.value >= entry.from && point.value < entry.to,
      ) ?? bins.at(-1);
    if (bin !== undefined) {
      bin.total += 1;
      bin.positive += point.positive ? 1 : 0;
    }
  }
  return bins;
}

export function jobReliability(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
  tool?: string,
): ReliabilityBin[] {
  const byId = new Map(cases.map((probeCase) => [probeCase.id, probeCase]));
  return binsOf(
    runs.flatMap((run) =>
      run.rows.flatMap((row) => {
        const probeCase = byId.get(row.caseId);
        if (probeCase === undefined || row.answers === undefined) {
          return [];
        }
        const accepted = new Set(
          [probeCase.expected, ...(probeCase.alsoOk ?? [])].flatMap((call) =>
            call === null ? [] : [call.tool],
          ),
        );
        return specs
          .filter((spec) => tool === undefined || spec.tool === tool)
          .flatMap((spec) => {
            const answer = row.answers?.[`job:${spec.tool}`];
            return answer?.type === "noul"
              ? [
                  {
                    value: answer.probability,
                    positive: accepted.has(spec.tool),
                  },
                ]
              : [];
          });
      }),
    ),
  );
}

export function argumentReliability(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
): ReliabilityBin[] {
  const open = withThresholds(
    specs,
    Object.fromEntries(
      specs.map((spec) => [spec.tool, { take: 0.5, act: 0.5, argument: 0 }]),
    ),
  );
  return binsOf(
    runs.flatMap((run) => {
      const rows = new Map(run.rows.map((row) => [row.caseId, row]));
      return cases.flatMap((probeCase) => {
        const verdict = verdictOf(probeCase, rows.get(probeCase.id), open);
        const call = verdict.decision?.call;
        return verdict.outcome === "delegated" ||
          call === undefined ||
          call.tool !== probeCase.expected?.tool
          ? []
          : [
              {
                value: call.minConfidence,
                positive: verdict.outcome === "correct",
              },
            ];
      });
    }),
  );
}

export function unstableCases(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
): { readonly caseId: string; readonly outcomes: readonly string[] }[] {
  return cases.flatMap((probeCase) => {
    const outcomes = runs.map((run) => {
      const verdict = verdictOf(
        probeCase,
        run.rows.find((row) => row.caseId === probeCase.id),
        specs,
      );
      return verdict.outcome === "delegated"
        ? "delegated"
        : `${verdict.outcome}:${JSON.stringify(verdict.decision?.call?.args)}`;
    });
    return new Set(outcomes).size > 1
      ? [{ caseId: probeCase.id, outcomes }]
      : [];
  });
}
