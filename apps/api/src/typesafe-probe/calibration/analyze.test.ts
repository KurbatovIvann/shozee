import { STAFF_JUDGMENT_SPECS, type JudgmentAnswer } from "@showzy/ai";
import { describe, expect, it } from "vitest";

import {
  chooseThresholds,
  jobReliability,
  sweepSpec,
  tallyBy,
  unstableCases,
  verdictOf,
  wilsonUpper,
  withThresholds,
  type CalibrationRun,
} from "./analyze.js";
import type { CalibrationCase } from "./case.js";
import { renderCalibration } from "./report.js";

const choice = (value: string, confidence = 0.95): JudgmentAnswer => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: {},
});
const yes = (probability: number): JudgmentAnswer => ({
  type: "noul",
  probability,
});

const probeCase = (
  id: string,
  split: CalibrationCase["split"],
  message: string,
  expected: CalibrationCase["expected"],
): CalibrationCase => ({
  id,
  split,
  group: expected?.tool ?? "talk",
  trait: expected === null ? "talk" : "direct",
  message,
  expected,
});

const CASES = [
  probeCase("count-1", "tune", "Скільки замовлень сьогодні?", {
    tool: "orders_list_counts",
    args: { period: "today" },
  }),
  probeCase("count-2", "holdout", "Скільки замовлень цього тижня?", {
    tool: "orders_list_counts",
    args: { period: "this_week" },
  }),
  probeCase("find-1", "tune", "Знайди клієнта Олену Петренко", {
    tool: "customers_list_customers",
    args: { search: "Олена Петренко" },
  }),
  probeCase("list-1", "tune", "Покажи замовлення", {
    tool: "orders_list_page",
    args: {},
  }),
  probeCase("talk-1", "tune", "Дякую!", null),
];

const request = { kind: choice("request") };
const run = (countOne: number): CalibrationRun => ({
  model: "jev-test",
  rows: [
    {
      caseId: "count-1",
      latencyMs: 300,
      inputTokens: 5000,
      answers: {
        ...request,
        "job:orders_list_counts": yes(countOne),
        "slot:period": choice("today"),
      },
    },
    {
      caseId: "count-2",
      latencyMs: 320,
      inputTokens: 5000,
      answers: {
        ...request,
        "job:orders_list_counts": yes(0.97),
        "slot:period": choice("this_week", 0.75),
      },
    },
    {
      caseId: "find-1",
      latencyMs: 310,
      inputTokens: 5000,
      answers: {
        ...request,
        "job:customers_list_customers": yes(0.96),
        "slot:customerName": choice("олену петренко"),
      },
    },
    {
      caseId: "list-1",
      latencyMs: 305,
      inputTokens: 5000,
      answers: { ...request, "job:orders_list_counts": yes(0.8) },
    },
    { caseId: "talk-1", latencyMs: 290, inputTokens: 0, refusal: "timeout" },
  ],
});
const RUNS = [run(0.97), run(0.8)];

describe("verdictOf", () => {
  it("scores a taken call and reports why a request was delegated", () => {
    const rows = RUNS[0]?.rows ?? [];
    const verdict = (index: number) =>
      verdictOf(
        CASES[index] ?? probeCase("x", "tune", "x", null),
        rows[index],
        STAFF_JUDGMENT_SPECS,
      );
    expect(verdict(0)).toMatchObject({
      outcome: "correct",
      tool: "orders_list_counts",
    });
    expect(verdict(2).outcome).toBe("correct");
    expect(verdict(3)).toMatchObject({
      outcome: "delegated",
      reason: "low_argument_confidence",
    });
    expect(verdict(4)).toMatchObject({
      outcome: "delegated",
      reason: "timeout",
    });
  });

  it("calls a confident plan for another tool wrong", () => {
    const loose = withThresholds(STAFF_JUDGMENT_SPECS, {
      orders_list_counts: { act: 0.7 },
    });
    expect(
      verdictOf(
        CASES[3] ?? probeCase("x", "tune", "x", null),
        RUNS[0]?.rows[3],
        loose,
      ),
    ).toMatchObject({ outcome: "wrong", tool: "orders_list_counts" });
  });
});

describe("the sweep", () => {
  it("counts a tool's calls per split and picks the pair with no wrong call", () => {
    const points = sweepSpec(
      "orders_list_counts",
      CASES,
      RUNS,
      STAFF_JUDGMENT_SPECS,
    );
    const at = (act: number, argument: number) =>
      points.find(
        (point) =>
          point.thresholds.act === act &&
          point.thresholds.argument === argument,
      );
    expect(at(0.85, 0.7)?.tune).toEqual({ correct: 1, wrong: 0, delegated: 0 });
    expect(at(0.7, 0.7)?.tune).toEqual({ correct: 2, wrong: 2, delegated: 0 });
    expect(at(0.85, 0.8)?.holdout.correct).toBe(0);
    expect(chooseThresholds(points)?.thresholds).toEqual({
      take: 0.7,
      act: 0.95,
      argument: 0.9,
    });
  });

  it("tallies by any key and finds a case that changed between runs", () => {
    const byGroup = tallyBy(
      CASES,
      RUNS,
      STAFF_JUDGMENT_SPECS,
      (entry) => entry.group,
    );
    expect(byGroup.get("orders_list_counts")).toEqual({
      correct: 3,
      wrong: 0,
      delegated: 1,
    });
    expect(
      unstableCases(CASES, RUNS, STAFF_JUDGMENT_SPECS).map(
        (entry) => entry.caseId,
      ),
    ).toEqual(["count-1"]);
  });
});

describe("reliability", () => {
  it("bins a job answer against whether the job was that one", () => {
    const bins = jobReliability(
      CASES,
      RUNS,
      STAFF_JUDGMENT_SPECS,
      "orders_list_counts",
    );
    expect(bins.find((bin) => bin.from === 0.7)).toMatchObject({
      total: 3,
      positive: 1,
    });
    expect(bins.at(-1)).toMatchObject({ total: 3, positive: 3 });
  });

  it("bounds a wrong share from above", () => {
    expect(wilsonUpper(0, 25)).toBeGreaterThan(0.1);
    expect(wilsonUpper(0, 300)).toBeLessThan(0.013);
    expect(wilsonUpper(0, 0)).toBeNaN();
  });
});

describe("renderCalibration", () => {
  it("renders every section from saved runs", () => {
    const report = renderCalibration(CASES, RUNS, STAFF_JUDGMENT_SPECS);
    expect(report).toContain("| orders_list_counts | 3 | 0 | 1 |");
    expect(report).toContain("Cases that changed between runs: 1");
    expect(report).toContain("| production |");
  });
});
