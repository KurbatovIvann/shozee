import {
  createTypeSafeJudgmentProvider,
  staffAssistantTools,
} from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";
import { aiToolSourcesForPrincipal } from "@showzy/contract";

import { createActionRegistry } from "../registry.js";
import { PROBE_CASES } from "./corpus.js";
import { renderProbeMarkdown, runProbe, type ProbeTool } from "./probe.js";

export function staffProbeTools(): readonly ProbeTool[] {
  const contracts = aiToolSourcesForPrincipal(
    createActionRegistry().contracts(),
    "staff",
  );
  const tools = staffAssistantTools(contracts, () => Promise.resolve({}));
  return Object.entries(tools).flatMap(([name, tool]) =>
    typeof tool.description === "string" && tool.description !== ""
      ? [{ name, description: tool.description.replaceAll(/\s+/g, " ") }]
      : [],
  );
}

async function main(): Promise<void> {
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
  const rows = await runProbe({
    provider,
    cases: PROBE_CASES,
    tools: staffProbeTools(),
  });
  process.stdout.write(`${renderProbeMarkdown(provider.model, rows)}\n`);
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  await main();
}
