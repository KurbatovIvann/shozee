import { judgmentThresholdsOf, type StaffJudgmentSpec } from "@showzy/ai";

import {
  TYPESAFE_USD_PER_INPUT_MTOK,
  mean,
  num,
  pct,
  percentile,
} from "../probe.js";
import {
  argumentReliability,
  chooseThresholds,
  jobReliability,
  sweepSpec,
  tallyBy,
  unstableCases,
  verdictOf,
  wilsonUpper,
  withThresholds,
  type CalibrationRun,
  type ReliabilityBin,
  type SpecThresholds,
  type Tally,
} from "./analyze.js";
import type { CalibrationCase } from "./case.js";

const EMPTY: Tally = { correct: 0, wrong: 0, delegated: 0 };

const tallyCells = (tally: Tally): string =>
  `${String(tally.correct)} | ${String(tally.wrong)} | ${String(tally.delegated)}`;

const taken = (tally: Tally): number => tally.correct + tally.wrong;

function reliabilityTable(title: string, bins: readonly ReliabilityBin[]) {
  return [
    `### ${title}`,
    "",
    "| Answer | Observations | Truly so |",
    "| --- | --- | --- |",
    ...bins.map(
      (bin) =>
        `| ${num(bin.from)}–${num(bin.to)} | ${String(bin.total)} | ${pct(bin.positive / bin.total)} |`,
    ),
    "",
  ];
}

function reasonsTable(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
): string[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const rows = new Map(run.rows.map((row) => [row.caseId, row]));
    for (const probeCase of cases) {
      const verdict = verdictOf(probeCase, rows.get(probeCase.id), specs);
      if (verdict.outcome === "delegated" && probeCase.trait !== "talk") {
        const key = `${probeCase.group} | ${verdict.reason ?? "?"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [
    "### Why a request was delegated (observations over all runs)",
    "",
    "| Group | Reason | Count |",
    "| --- | --- | --- |",
    ...[...counts.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => `| ${key} | ${String(count)} |`),
    "",
  ];
}

export function renderCalibration(
  cases: readonly CalibrationCase[],
  runs: readonly CalibrationRun[],
  specs: readonly StaffJudgmentSpec[],
): string {
  const rows = runs.flatMap((run) => run.rows);
  const answered = rows.filter((row) => row.answers !== undefined);
  const tokens = answered.reduce((sum, row) => sum + row.inputTokens, 0);
  const byGroup = tallyBy(cases, runs, specs, (probeCase) => probeCase.group);
  const byTrait = tallyBy(cases, runs, specs, (probeCase) => probeCase.trait);

  const chosen: Record<string, SpecThresholds> = {};
  const sweepLines = specs.map((spec) => {
    const points = sweepSpec(spec.tool, cases, runs, specs);
    const defaults = judgmentThresholdsOf(spec);
    const current = points.find(
      (point) =>
        point.thresholds.act === defaults.act &&
        point.thresholds.argument === defaults.argument,
    );
    const best = chooseThresholds(points);
    if (best !== undefined) {
      chosen[spec.tool] = best.thresholds;
    }
    const cell = (tally: Tally | undefined): string =>
      tally === undefined
        ? "n/a"
        : `${String(tally.correct)}/${String(tally.wrong)}`;
    return `| ${spec.tool} | ${cell(current?.tune)} | ${cell(current?.holdout)} | ${
      best === undefined
        ? "n/a"
        : `${num(best.thresholds.act)} / ${num(best.thresholds.argument)}`
    } | ${cell(best?.tune)} | ${cell(best?.holdout)} | ${
      best === undefined
        ? "n/a"
        : pct(wilsonUpper(best.holdout.wrong, taken(best.holdout)))
    } |`;
  });

  const names = tallyBy(cases, runs, specs, (_, verdict) =>
    verdict.nameAsStored === undefined
      ? "n/a"
      : `${verdict.tool ?? ""} | ${verdict.nameAsStored ? "as it should be stored" : "as typed, in another case form"}`,
  );
  names.delete("n/a");

  const holdout = cases.filter((probeCase) => probeCase.split === "holdout");
  const jointNow =
    tallyBy(holdout, runs, specs, () => "all").get("all") ?? EMPTY;
  const jointChosen =
    tallyBy(holdout, runs, withThresholds(specs, chosen), () => "all").get(
      "all",
    ) ?? EMPTY;

  const firstRun = runs[0];
  const wrongLines =
    firstRun === undefined
      ? []
      : cases.flatMap((probeCase) => {
          const verdict = verdictOf(
            probeCase,
            firstRun.rows.find((row) => row.caseId === probeCase.id),
            specs,
          );
          return verdict.outcome === "wrong"
            ? [
                `| ${probeCase.id} | ${probeCase.message.replaceAll("|", "/")} | ${
                  verdict.tool ?? ""
                } ${JSON.stringify(verdict.decision?.call?.args ?? {})} | ${
                  probeCase.expected === null
                    ? "no call"
                    : `${probeCase.expected.tool} ${JSON.stringify(probeCase.expected.args)}`
                } |`,
              ]
            : [];
        });
  const unstable = unstableCases(cases, runs, specs);

  return [
    "## Calibration stand",
    "",
    `${String(cases.length)} cases, ${String(runs.length)} runs, model ${runs[0]?.model ?? "?"}. Requests answered ${String(answered.length)}/${String(rows.length)}; latency p50 ${num(
      percentile(
        answered.map((row) => row.latencyMs),
        0.5,
      ),
      0,
    )} ms, p95 ${num(
      percentile(
        answered.map((row) => row.latencyMs),
        0.95,
      ),
      0,
    )} ms; ${num(mean(answered.map((row) => row.inputTokens)), 0)} input tokens a request, $${num((tokens / 1_000_000) * TYPESAFE_USD_PER_INPUT_MTOK, 3)} in all.`,
    "",
    "Every write counts as takeable here. Counts are observations: one case in one run.",
    "",
    "### Production thresholds, by group",
    "",
    "| Group | Correct | Wrong | Delegated |",
    "| --- | --- | --- | --- |",
    ...[...byGroup.entries()].map(
      ([group, tally]) => `| ${group} | ${tallyCells(tally)} |`,
    ),
    "",
    "### Production thresholds, by trait",
    "",
    "| Trait | Correct | Wrong | Delegated |",
    "| --- | --- | --- | --- |",
    ...[...byTrait.entries()].map(
      ([trait, tally]) => `| ${trait} | ${tallyCells(tally)} |`,
    ),
    "",
    ...reasonsTable(cases, runs, specs),
    ...reliabilityTable(
      "Job question: answer against how often the job truly was that one",
      jobReliability(cases, runs, specs),
    ),
    ...reliabilityTable(
      "Lowest argument confidence against how often the whole call was right",
      argumentReliability(cases, runs, specs),
    ),
    "### New names in correct calls",
    "",
    "| Tool | The name the call carries | Observations |",
    "| --- | --- | --- |",
    ...[...names.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, tally]) => `| ${key} | ${String(tally.correct)} |`),
    "",
    "### Thresholds per spec (correct/wrong among calls to that tool)",
    "",
    "Chosen on the tuning split: no wrong call, then the most correct ones, then the stricter pair. The bound is the 95% upper limit of the wrong share on the held-out split at the chosen pair.",
    "",
    "| Tool | Now: tune | Now: held out | Chosen act / argument | Chosen: tune | Chosen: held out | Wrong share, upper bound |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...sweepLines,
    "",
    "### Held-out split, all chosen thresholds together",
    "",
    "| Thresholds | Correct | Wrong | Delegated |",
    "| --- | --- | --- | --- |",
    `| production | ${tallyCells(jointNow)} |`,
    `| chosen | ${tallyCells(jointChosen)} |`,
    "",
    `### Cases that changed between runs: ${String(unstable.length)}`,
    "",
    "| Case | Per run |",
    "| --- | --- |",
    ...unstable.map(
      (entry) =>
        `| ${entry.caseId} | ${entry.outcomes.map((outcome) => outcome.split(":")[0]).join(", ")} |`,
    ),
    "",
    "### Wrong calls at production thresholds, first run",
    "",
    "| Case | Message | Planned | Expected |",
    "| --- | --- | --- | --- |",
    ...wrongLines,
    "",
  ].join("\n");
}
