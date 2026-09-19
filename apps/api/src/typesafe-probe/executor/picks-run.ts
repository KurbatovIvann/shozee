import { createTypeSafeJudgmentProvider } from "@showzy/ai";
import { loadServerConfig } from "@showzy/config";

import { PICK_CASES, renderPickMarkdown, runPickProbe } from "./picks.js";

const { ai } = loadServerConfig();
if (ai.typesafeApiKey === undefined) {
  process.stderr.write("TYPESAFE_API_KEY is not set; nothing was sent.\n");
  process.exitCode = 1;
} else {
  const provider = createTypeSafeJudgmentProvider({
    apiKey: ai.typesafeApiKey,
    model: ai.typesafeModel,
  });
  const rows = await runPickProbe(provider, PICK_CASES);
  process.stdout.write(`${renderPickMarkdown(provider.model, rows)}\n`);
}
