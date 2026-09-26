import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  STAFF_JUDGMENT_SPECS,
  buildStaffPlanQuestions,
  createTypeSafeJudgmentProvider,
  type JudgmentProvider,
} from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";

import type { CalibrationAnswerRow, CalibrationRun } from "./analyze.js";
import type { CalibrationCase } from "./case.js";
import { CALIBRATION_CASES } from "./corpus/index.js";
import { renderCalibration } from "./report.js";

const POOL = 4;

async function askAll(
  provider: JudgmentProvider,
  cases: readonly CalibrationCase[],
): Promise<CalibrationAnswerRow[]> {
  const rows = new Array<CalibrationAnswerRow>(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      while (next < cases.length) {
        const index = next;
        next += 1;
        const probeCase = cases[index];
        if (probeCase === undefined) {
          continue;
        }
        const startedAt = performance.now();
        const result = await provider.ask({
          state: { message: probeCase.message },
          questions: buildStaffPlanQuestions(
            probeCase.message,
            STAFF_JUDGMENT_SPECS,
          ),
        });
        const latencyMs = Math.round(performance.now() - startedAt);
        rows[index] = result.ok
          ? {
              caseId: probeCase.id,
              answers: result.answers,
              latencyMs,
              inputTokens: result.usage.inputTokens,
            }
          : {
              caseId: probeCase.id,
              refusal: result.reason,
              latencyMs,
              inputTokens: 0,
            };
      }
    }),
  );
  return rows;
}

const savedRuns = (dir: string): CalibrationRun[] =>
  readdirSync(dir)
    .filter((name) => /^run-\d+\.json$/.test(name))
    .toSorted()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(dir, name), "utf8")) as CalibrationRun,
    );

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    dir: { type: "string" },
    report: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
const onlyGroups = values.only?.split(",");
const cases =
  onlyGroups === undefined
    ? CALIBRATION_CASES
    : CALIBRATION_CASES.filter((probeCase) =>
        onlyGroups.includes(probeCase.group),
      );
const { ai } = loadServerConfig();

if (values.dir === undefined) {
  process.stderr.write("--dir is required; nothing was sent.\n");
  process.exitCode = 1;
} else if (values.report) {
  process.stdout.write(
    `${renderCalibration(cases, savedRuns(values.dir), STAFF_JUDGMENT_SPECS)}\n`,
  );
} else if (ai.typesafeApiKey === undefined) {
  process.stderr.write("TYPESAFE_API_KEY is required; nothing was sent.\n");
  process.exitCode = 1;
} else {
  const provider = createTypeSafeJudgmentProvider({
    apiKey: ai.typesafeApiKey,
    model: ai.typesafeModel,
  });
  mkdirSync(values.dir, { recursive: true });
  for (let run = 1; run <= Number(values.runs); run += 1) {
    const rows = await askAll(provider, cases);
    const saved: CalibrationRun = { model: provider.model, rows };
    writeFileSync(
      join(values.dir, `run-${String(run)}.json`),
      JSON.stringify(saved),
    );
    process.stderr.write(`run ${String(run)} saved\n`);
  }
  process.stdout.write(
    `${renderCalibration(cases, savedRuns(values.dir), STAFF_JUDGMENT_SPECS)}\n`,
  );
}
