import type {
  JudgmentAnswer,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentRefusalReason,
  JudgmentText,
} from "@showzy/ai";

import {
  TYPESAFE_USD_PER_INPUT_MTOK,
  mean,
  num,
  pct,
  percentile,
  share,
} from "../probe.js";
import { numberCandidates, spanCandidates } from "./candidates.js";
import {
  CLOSED_SLOTS,
  EXECUTOR_JOBS,
  EXECUTOR_NONE,
  ITEM_POSITIONS,
  JOB_SLOTS,
  NUMBER_SLOTS,
  SPAN_SLOTS,
  type ExecutorCase,
  type ExecutorJob,
  type ExecutorSlot,
} from "./corpus.js";

export const JOB_THRESHOLD = 0.5;
export const PLAN_CONFIDENCE_THRESHOLDS = [0.5, 0.7, 0.9] as const;

const ORDINALS = { 1: "first", 2: "second", 3: "third" } as const;
const jobKey = (job: string): string => `job_${job}`;
const slotKey = (slot: string): string => `slot_${slot}`;
const itemProductKey = (position: number): string =>
  `item${String(position)}_product`;
const itemQuantityKey = (position: number): string =>
  `item${String(position)}_quantity`;

function candidateCriteria(
  candidates: readonly string[],
): Record<string, JudgmentText | null> {
  const criteria: Record<string, JudgmentText | null> = {};
  for (const candidate of candidates) {
    criteria[candidate] = null;
  }
  criteria[EXECUTOR_NONE] = "The message does not state this.";
  return criteria;
}

function pick(what: string, candidates: readonly string[]): JudgmentQuestion {
  return {
    type: "choice",
    instructions: `Which option is ${what} in \`message\`? Choose \`${EXECUTOR_NONE}\` when the message does not state it.`,
    criteria: candidateCriteria(candidates),
  };
}

export function buildPlanQuestions(
  message: string,
): Record<string, JudgmentQuestion> {
  const spans = spanCandidates(message);
  const numbers = numberCandidates(message);
  const questions: Record<string, JudgmentQuestion> = {};
  for (const [job, { yes, no }] of Object.entries(EXECUTOR_JOBS)) {
    questions[jobKey(job)] = {
      type: "noul",
      instructions: `Does \`message\` ask the assistant to ${yes}?`,
      criteria: { true: `The message asks to ${yes}.`, false: no },
    };
  }
  for (const [slot, what] of Object.entries(SPAN_SLOTS)) {
    questions[slotKey(slot)] = pick(what, spans);
  }
  for (const [slot, closed] of Object.entries(CLOSED_SLOTS)) {
    questions[slotKey(slot)] = { type: "choice", ...closed };
  }
  for (const position of ITEM_POSITIONS) {
    questions[itemProductKey(position)] = pick(
      `the name of the ${ORDINALS[position]} product being ordered, without its quantity,`,
      spans,
    );
  }
  if (numbers.length > 0) {
    for (const [slot, what] of Object.entries(NUMBER_SLOTS)) {
      questions[slotKey(slot)] = pick(what, numbers);
    }
    for (const position of ITEM_POSITIONS) {
      questions[itemQuantityKey(position)] = pick(
        `the quantity of the ${ORDINALS[position]} product being ordered`,
        numbers,
      );
    }
  }
  return questions;
}

export interface PlanPick {
  readonly choice: string;
  readonly confidence: number;
}

export interface PlanRow {
  readonly caseId: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly refusal?: JudgmentRefusalReason;
  readonly jobs: Readonly<Record<string, number>>;
  readonly picks: Readonly<Record<string, PlanPick>>;
}

const UNSTATED: PlanPick = { choice: EXECUTOR_NONE, confidence: 1 };

function toRow(
  caseId: string,
  latencyMs: number,
  inputTokens: number,
  answers: Readonly<Record<string, JudgmentAnswer>>,
): PlanRow {
  const jobs: Record<string, number> = {};
  const picks: Record<string, PlanPick> = {};
  for (const [key, answer] of Object.entries(answers)) {
    if (answer.type === "noul") {
      jobs[key] = answer.probability;
    } else if (answer.type === "choice") {
      picks[key] = { choice: answer.choice, confidence: answer.confidence };
    }
  }
  return { caseId, latencyMs, inputTokens, jobs, picks };
}

export interface RunPlanProbeOptions {
  readonly provider: JudgmentProvider;
  readonly cases: readonly ExecutorCase[];
  readonly concurrency?: number;
  readonly now?: () => number;
}

export async function runPlanProbe(
  options: RunPlanProbeOptions,
): Promise<PlanRow[]> {
  const now = options.now ?? (() => performance.now());
  const rows: PlanRow[] = [];
  const width = Math.max(1, options.concurrency ?? 4);
  for (let index = 0; index < options.cases.length; index += width) {
    const batch = options.cases.slice(index, index + width);
    rows.push(
      ...(await Promise.all(
        batch.map(async (probeCase) => {
          const startedAt = now();
          const result = await options.provider.ask({
            state: { message: probeCase.uk },
            questions: buildPlanQuestions(probeCase.uk),
          });
          const latencyMs = now() - startedAt;
          return result.ok
            ? toRow(
                probeCase.id,
                latencyMs,
                result.usage.inputTokens,
                result.answers,
              )
            : {
                caseId: probeCase.id,
                latencyMs,
                inputTokens: 0,
                refusal: result.reason,
                jobs: {},
                picks: {},
              };
        }),
      )),
    );
  }
  return rows;
}

export interface SlotScore {
  readonly slot: string;
  readonly expected: readonly string[];
  readonly got: string;
  readonly confidence: number;
  readonly correct: boolean;
}

export interface PlanScore {
  readonly caseId: string;
  readonly chain: boolean;
  readonly refused: boolean;
  readonly missingJobs: readonly string[];
  readonly extraJobs: readonly string[];
  readonly slots: readonly SlotScore[];
  readonly itemsCorrect: boolean;
  readonly detectedItems: readonly string[];
  readonly planCorrect: boolean;
  readonly minConfidence: number;
}

function detectedItems(row: PlanRow): { pairs: string[]; confidence: number } {
  const pairs: string[] = [];
  let confidence = 1;
  for (const position of ITEM_POSITIONS) {
    const product = row.picks[itemProductKey(position)] ?? UNSTATED;
    if (
      product.choice === EXECUTOR_NONE ||
      pairs.some((pair) => pair.endsWith(`×${product.choice}`))
    ) {
      continue;
    }
    const quantity = row.picks[itemQuantityKey(position)] ?? UNSTATED;
    pairs.push(`${quantity.choice}×${product.choice}`);
    confidence = Math.min(confidence, product.confidence, quantity.confidence);
  }
  return { pairs, confidence };
}

export function scorePlan(probeCase: ExecutorCase, row: PlanRow): PlanScore {
  const expectedJobs = new Set<string>(probeCase.jobs);
  const detectedJobs = Object.keys(EXECUTOR_JOBS).filter(
    (job) => (row.jobs[jobKey(job)] ?? 0) >= JOB_THRESHOLD,
  );
  const missingJobs = probeCase.jobs.filter(
    (job) => !detectedJobs.includes(job),
  );
  const extraJobs = detectedJobs.filter((job) => !expectedJobs.has(job));

  const consumed = new Set<ExecutorSlot>([
    ...probeCase.jobs.flatMap((job: ExecutorJob) => JOB_SLOTS[job]),
    ...(Object.keys(probeCase.slots ?? {}) as ExecutorSlot[]),
  ]);
  const slots = [...consumed].map((slot): SlotScore => {
    const expected = probeCase.slots?.[slot] ?? [EXECUTOR_NONE];
    const got = row.picks[slotKey(slot)] ?? UNSTATED;
    return {
      slot,
      expected,
      got: got.choice,
      confidence: got.confidence,
      correct: expected.includes(got.choice),
    };
  });

  const items = detectedItems(row);
  const expectedItems = probeCase.items ?? [];
  const wantsItems = expectedJobs.has("create_order");
  const itemsCorrect =
    !wantsItems ||
    (items.pairs.length === expectedItems.length &&
      expectedItems.every((expected) =>
        expected.product.some((product) =>
          items.pairs.includes(`${expected.quantity}×${product}`),
        ),
      ));

  const jobConfidences = Object.values(row.jobs).map(
    (probability) => Math.abs(probability - 0.5) * 2,
  );
  const refused = row.refusal !== undefined;
  return {
    caseId: probeCase.id,
    chain: probeCase.jobs.length > 1,
    refused,
    missingJobs,
    extraJobs,
    slots,
    itemsCorrect,
    detectedItems: items.pairs,
    planCorrect:
      !refused &&
      missingJobs.length === 0 &&
      extraJobs.length === 0 &&
      itemsCorrect &&
      slots.every((slot) => slot.correct),
    minConfidence: Math.min(
      1,
      ...jobConfidences,
      ...slots.map((slot) => slot.confidence),
      ...(wantsItems ? [items.confidence] : []),
    ),
  };
}

export function scorePlans(
  cases: readonly ExecutorCase[],
  rows: readonly PlanRow[],
): PlanScore[] {
  const byId = new Map(rows.map((row) => [row.caseId, row]));
  return cases.flatMap((probeCase) => {
    const row = byId.get(probeCase.id);
    return row === undefined ? [] : [scorePlan(probeCase, row)];
  });
}

export function renderPlanMarkdown(
  model: string,
  cases: readonly ExecutorCase[],
  rows: readonly PlanRow[],
): string {
  const scores = scorePlans(cases, rows);
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const group = (label: string, subset: readonly PlanScore[]): string =>
    `| ${label} | ${String(subset.length)} | ${pct(share(subset.map((s) => s.missingJobs.length === 0 && s.extraJobs.length === 0)))} | ${pct(share(subset.map((s) => s.slots.every((slot) => slot.correct))))} | ${pct(share(subset.map((s) => s.itemsCorrect)))} | ${pct(share(subset.map((s) => s.planCorrect)))} |`;
  const slotNames = [
    ...new Set(scores.flatMap((s) => s.slots.map((slot) => slot.slot))),
  ];
  const jobCount = new Map(cases.map((c) => [c.id, c.jobs.length]));
  const inflected = cases.filter((c) => c.inflected === true).length;
  return [
    `Model \`${model}\`, ${String(rows.length)} requests, ${String(inputTokens)} input tokens, $${((inputTokens / 1_000_000) * TYPESAFE_USD_PER_INPUT_MTOK).toFixed(4)}; mean ${num(mean(rows.map((row) => row.inputTokens)), 0)} tokens a request; latency p50 ${num(
      percentile(
        rows.map((row) => row.latencyMs),
        0.5,
      ),
      0,
    )} ms, p95 ${num(
      percentile(
        rows.map((row) => row.latencyMs),
        0.95,
      ),
      0,
    )} ms. Refused: ${String(scores.filter((s) => s.refused).length)}.`,
    "",
    "| Cases | n | Jobs exact | Slots all correct | Items correct | Whole plan correct |",
    "| --- | --- | --- | --- | --- | --- |",
    group("all", scores),
    group(
      "single job",
      scores.filter((s) => jobCount.get(s.caseId) === 1),
    ),
    group(
      "chains (2–4 jobs)",
      scores.filter((s) => s.chain),
    ),
    group(
      "no job expected",
      scores.filter((s) => jobCount.get(s.caseId) === 0),
    ),
    "",
    "| Plan min confidence ≥ | Coverage | Whole plan correct |",
    "| --- | --- | --- |",
    ...PLAN_CONFIDENCE_THRESHOLDS.map((threshold) => {
      const kept = scores.filter((s) => s.minConfidence >= threshold);
      return `| ${num(threshold, 1)} | ${pct(kept.length / Math.max(1, scores.length))} | ${pct(share(kept.map((s) => s.planCorrect)))} |`;
    }),
    "",
    "| Slot | Asked | Correct |",
    "| --- | --- | --- |",
    ...slotNames.map((name) => {
      const asked = scores.flatMap((s) =>
        s.slots.filter((slot) => slot.slot === name),
      );
      return `| ${name} | ${String(asked.length)} | ${pct(share(asked.map((slot) => slot.correct)))} |`;
    }),
    "",
    `Cases whose selected span is an inflected form that code cannot use as a stored name or an exact lookup: ${String(inflected)} of ${String(cases.length)}.`,
    "",
    "Wrong plans:",
    "",
    "| Case | Min conf | Missing jobs | Extra jobs | Wrong slots | Items |",
    "| --- | --- | --- | --- | --- | --- |",
    ...scores
      .filter((s) => !s.planCorrect)
      .map(
        (s) =>
          `| ${s.caseId} | ${num(s.minConfidence)} | ${s.missingJobs.join(", ")} | ${s.extraJobs.join(", ")} | ${s.slots
            .filter((slot) => !slot.correct)
            .map(
              (slot) => `${slot.slot}: ${slot.got} (${num(slot.confidence)})`,
            )
            .join(
              "; ",
            )} | ${s.itemsCorrect ? "" : s.detectedItems.join(", ")} |`,
      ),
  ].join("\n");
}
