import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createTypeSafeJudgmentProvider } from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";
import { z } from "zod";

import { EXECUTOR_CASES, type ExecutorCase } from "./corpus.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { renderPlanMarkdown, runPlanProbe, type PlanRow } from "./plan.js";

const CASE_SETS: Readonly<Record<string, readonly ExecutorCase[]>> = {
  tuning: EXECUTOR_CASES,
  holdout: HOLDOUT_CASES,
};

const rawRowSchema = z.object({
  caseId: z.string(),
  latencyMs: z.number(),
  inputTokens: z.number(),
  refusal: z
    .enum(["timeout", "rate_limited", "overloaded", "rejected", "unavailable"])
    .optional(),
  jobs: z.record(z.string(), z.number()),
  picks: z.record(
    z.string(),
    z.object({ choice: z.string(), confidence: z.number() }),
  ),
});

const rawRunSchema = z.object({
  model: z.string(),
  rows: z.array(rawRowSchema),
});

function toPlanRow(row: z.infer<typeof rawRowSchema>): PlanRow {
  const { refusal, ...rest } = row;
  return refusal === undefined ? rest : { ...rest, refusal };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      set: { type: "string", default: "tuning" },
      raw: { type: "string" },
      rescore: { type: "string" },
    },
  });
  const cases = CASE_SETS[values.set];
  if (cases === undefined) {
    process.stderr.write(`Unknown --set ${values.set}.\n`);
    process.exitCode = 1;
    return;
  }
  if (values.rescore !== undefined) {
    const raw = rawRunSchema.parse(
      JSON.parse(readFileSync(values.rescore, "utf8")),
    );
    process.stdout.write(
      `${renderPlanMarkdown(raw.model, cases, raw.rows.map(toPlanRow))}\n`,
    );
    return;
  }
  const { ai } = loadServerConfig();
  if (ai.typesafeApiKey === undefined) {
    process.stderr.write("TYPESAFE_API_KEY is not set; nothing was sent.\n");
    process.exitCode = 1;
    return;
  }
  const provider = createTypeSafeJudgmentProvider({
    apiKey: ai.typesafeApiKey,
    model: ai.typesafeModel,
  });
  const rows = await runPlanProbe({ provider, cases });
  if (values.raw !== undefined) {
    writeFileSync(
      values.raw,
      JSON.stringify({ model: provider.model, rows }, null, 2),
    );
  }
  process.stdout.write(`${renderPlanMarkdown(provider.model, cases, rows)}\n`);
}

await main();
