import { createStaffLanguageModel } from "@showzy/ai";
import { loadServerConfig, type ServerConfig } from "@showzy/config";
import type { ModelMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EvalRunsConfigError,
  evalRunsFromInjectedFlag,
  requireStaffAssistantApiKey,
} from "../config.js";
import { createEvalLogger } from "../log.js";
import { formatEvalReport } from "../reporter.js";
import { runEvalSuite } from "../run-eval.js";
import { runStaffAssistantEvalTurn, type EvalTurnResult } from "../run-turn.js";
import { createEvalSandbox, type EvalSandbox } from "../sandbox.js";
import type { EvalScenario } from "../scenario.js";
import { GATE_CLASSIFIES_SCENARIOS } from "../scenarios/gate-classifies.js";
import { MODEL_SPEAKS_SCENARIOS } from "../scenarios/model-speaks.js";
import { PLAIN_REPLY_SCENARIOS } from "../scenarios/plain-reply.js";
import { PROOF_SCENARIOS } from "../scenarios/proof.js";

const EVAL_CORPUS_SCENARIOS = [
  ...PROOF_SCENARIOS,
  ...PLAIN_REPLY_SCENARIOS,
  ...MODEL_SPEAKS_SCENARIOS,
  ...GATE_CLASSIFIES_SCENARIOS,
];

const logger = createEvalLogger();
/** `eval-cli.mjs` injects `--runs`; this is not `ANTHROPIC_API_KEY`. */
const runs = evalRunsFromInjectedFlag(process.env.SHOWZY_EVAL_RUNS);

describe("staff assistant corpus eval (live, SHO-412 / SHO-507 / SHO-511 / SHO-513)", () => {
  let sandbox: EvalSandbox | undefined;
  let config!: ServerConfig;
  let languageModel!: ReturnType<typeof createStaffLanguageModel>;
  let gateLanguageModel!: ReturnType<typeof createStaffLanguageModel>;

  beforeAll(async () => {
    config = loadServerConfig();
    const apiKey = requireStaffAssistantApiKey(config.ai);
    languageModel = createStaffLanguageModel({
      apiKey,
      model: config.ai.model,
    });
    gateLanguageModel = createStaffLanguageModel({
      apiKey,
      model: config.ai.gateModel,
    });
    sandbox = await createEvalSandbox();
  }, 180_000);

  afterAll(async () => {
    await sandbox?.close();
  });

  it(`runs ${String(EVAL_CORPUS_SCENARIOS.length)} corpus scenarios × ${String(runs)}`, async () => {
    if (sandbox === undefined) {
      throw new EvalRunsConfigError("Eval sandbox was not created.");
    }
    const activeSandbox = sandbox;
    const report = await runEvalSuite({
      scenarios: EVAL_CORPUS_SCENARIOS,
      runs,
      runOnce: async (scenario: EvalScenario) => {
        const messages: ModelMessage[] = [];
        let last: EvalTurnResult | undefined;
        for (const turn of scenario.turns) {
          messages.push({ role: "user", content: turn.text });
          last = await runStaffAssistantEvalTurn({
            models: {
              languageModel,
              gateLanguageModel,
              replyModelId: config.ai.model,
              gateModelId: config.ai.gateModel,
            },
            messages,
            contracts: activeSandbox.contracts,
            execute: activeSandbox.execute,
            logger,
            companyName: activeSandbox.companyName,
          });
          messages.push({ role: "assistant", content: last.trace.text });
        }
        if (last === undefined) {
          throw new EvalRunsConfigError(
            `Scenario ${scenario.id} has no user turns.`,
          );
        }
        return last;
      },
    });

    process.stdout.write(`${formatEvalReport(report)}\n`);
    expect(report.green).toBe(true);
  });
});
