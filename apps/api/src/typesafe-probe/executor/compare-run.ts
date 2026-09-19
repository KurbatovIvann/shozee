import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  createStaffLanguageModel,
  createTypeSafeJudgmentProvider,
  type LanguageModel,
} from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";

import {
  TYPESAFE_USD_PER_INPUT_MTOK,
  mean,
  num,
  pct,
  percentile,
  share,
} from "../probe.js";
import type { ExecutorCase } from "./corpus.js";
import { HARD_CASES } from "./hard.js";
import { normalizeWithLlm, planWithLlm, type LlmUsage } from "./llm.js";
import { runPlanProbe, scorePlans, type PlanRow } from "./plan.js";

const USD_PER_MTOK = {
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
} as const;

interface ModeResult {
  readonly mode: string;
  readonly rows: readonly PlanRow[];
  readonly latenciesMs: readonly number[];
  readonly costUsd: number;
}

const llmCost = (usage: readonly LlmUsage[], kind: keyof typeof USD_PER_MTOK) =>
  usage.reduce(
    (sum, u) =>
      sum +
      (u.inputTokens * USD_PER_MTOK[kind].input +
        u.outputTokens * USD_PER_MTOK[kind].output) /
        1_000_000,
    0,
  );

const jevCost = (rows: readonly PlanRow[]) =>
  (rows.reduce((sum, row) => sum + row.inputTokens, 0) / 1_000_000) *
  TYPESAFE_USD_PER_INPUT_MTOK;

async function llmMode(
  mode: string,
  model: LanguageModel,
  kind: keyof typeof USD_PER_MTOK,
  cases: readonly ExecutorCase[],
): Promise<ModeResult> {
  const rows: PlanRow[] = [];
  const usage: LlmUsage[] = [];
  for (const probeCase of cases) {
    const result = await planWithLlm(model, probeCase.id, probeCase.uk);
    rows.push(result.row);
    usage.push(result.usage);
  }
  return {
    mode,
    rows,
    latenciesMs: rows.map((row) => row.latencyMs),
    costUsd: llmCost(usage, kind),
  };
}

function render(
  cases: readonly ExecutorCase[],
  results: readonly ModeResult[],
) {
  const lines = [
    "| Mode | Jobs exact | Slots all correct | Items correct | Whole plan correct | Latency p50 / p95 ms | Cost per turn |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const wrong: string[] = [];
  for (const result of results) {
    const scores = scorePlans(cases, result.rows);
    lines.push(
      `| ${result.mode} | ${pct(share(scores.map((s) => s.missingJobs.length === 0 && s.extraJobs.length === 0)))} | ${pct(share(scores.map((s) => s.slots.every((slot) => slot.correct))))} | ${pct(share(scores.map((s) => s.itemsCorrect)))} | ${pct(share(scores.map((s) => s.planCorrect)))} | ${num(percentile(result.latenciesMs, 0.5), 0)} / ${num(percentile(result.latenciesMs, 0.95), 0)} | $${(result.costUsd / Math.max(1, cases.length)).toFixed(5)} |`,
    );
    for (const s of scores.filter((score) => !score.planCorrect)) {
      wrong.push(
        `| ${result.mode} | ${s.caseId} | ${s.missingJobs.join(", ")} | ${s.extraJobs.join(", ")} | ${s.slots
          .filter((slot) => !slot.correct)
          .map((slot) => `${slot.slot}: ${slot.got}`)
          .join("; ")} | ${s.itemsCorrect ? "" : s.detectedItems.join(", ")} |`,
      );
    }
  }
  return [
    ...lines,
    "",
    "| Mode | Case | Missing jobs | Extra jobs | Wrong slots | Items |",
    "| --- | --- | --- | --- | --- | --- |",
    ...wrong,
  ].join("\n");
}

const { values } = parseArgs({ options: { raw: { type: "string" } } });
const { ai } = loadServerConfig();
if (ai.typesafeApiKey === undefined || ai.anthropicApiKey === undefined) {
  process.stderr.write(
    "TYPESAFE_API_KEY and ANTHROPIC_API_KEY are both required; nothing was sent.\n",
  );
  process.exitCode = 1;
} else {
  const jev = createTypeSafeJudgmentProvider({
    apiKey: ai.typesafeApiKey,
    model: ai.typesafeModel,
  });
  const sonnet = createStaffLanguageModel({
    apiKey: ai.anthropicApiKey,
    model: ai.model,
  });
  const haiku = createStaffLanguageModel({
    apiKey: ai.anthropicApiKey,
    model: ai.gateModel,
  });

  const rawRows = await runPlanProbe({ provider: jev, cases: HARD_CASES });

  const normalized: { text: string; usage: LlmUsage; latencyMs: number }[] = [];
  for (const probeCase of HARD_CASES) {
    const startedAt = performance.now();
    const result = await normalizeWithLlm(haiku, probeCase.uk);
    normalized.push({ ...result, latencyMs: performance.now() - startedAt });
  }
  const normalizedRows = await runPlanProbe({
    provider: jev,
    cases: HARD_CASES.map((probeCase, index) => ({
      ...probeCase,
      uk: normalized[index]?.text ?? probeCase.uk,
    })),
  });

  const results: ModeResult[] = [
    {
      mode: `Jev raw (${jev.model})`,
      rows: rawRows,
      latenciesMs: rawRows.map((row) => row.latencyMs),
      costUsd: jevCost(rawRows),
    },
    {
      mode: `Haiku normaliser → Jev`,
      rows: normalizedRows,
      latenciesMs: normalizedRows.map(
        (row, index) => row.latencyMs + (normalized[index]?.latencyMs ?? 0),
      ),
      costUsd:
        jevCost(normalizedRows) +
        llmCost(
          normalized.map((n) => n.usage),
          "haiku",
        ),
    },
    await llmMode(
      `Sonnet plans alone (${ai.model})`,
      sonnet,
      "sonnet",
      HARD_CASES,
    ),
    await llmMode(
      `Haiku plans alone (${ai.gateModel})`,
      haiku,
      "haiku",
      HARD_CASES,
    ),
  ];

  if (values.raw !== undefined) {
    writeFileSync(
      values.raw,
      JSON.stringify(
        {
          normalized: normalized.map((n, index) => ({
            caseId: HARD_CASES[index]?.id,
            original: HARD_CASES[index]?.uk,
            rewritten: n.text,
          })),
          results,
        },
        null,
        2,
      ),
    );
  }
  process.stdout.write(
    `${String(HARD_CASES.length)} hard cases. Normaliser mean latency ${num(mean(normalized.map((n) => n.latencyMs)), 0)} ms.\n\n${render(HARD_CASES, results)}\n`,
  );
}
