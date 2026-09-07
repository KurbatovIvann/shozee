import { describe, expect, it } from "vitest";

import { createEvalLogger, logEvalInfo, scrubEvalLogValue } from "./log.js";

const SECRET_KEY = "sk-ant-eval-secret-must-not-leak";
const PROMPT = "You are the secret staff system prompt. Never log this.";

describe("scrubEvalLogValue", () => {
  it("redacts api keys, system prompt, and messages", () => {
    const scrubbed = scrubEvalLogValue({
      apiKey: SECRET_KEY,
      anthropicApiKey: SECRET_KEY,
      systemPrompt: PROMPT,
      prompt: PROMPT,
      system: PROMPT,
      messages: [{ role: "user", content: "яка погода" }],
      body: { messages: [] },
      requestBody: '{"messages":[]}',
      tool_names: ["orders_list_counts"],
    });
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain("яка погода");
    expect(text).toContain("orders_list_counts");
  });
});

describe("createEvalLogger", () => {
  it("does not write prompt or key material", () => {
    const chunks: string[] = [];
    const logger = createEvalLogger({
      write(chunk: string) {
        chunks.push(chunk);
      },
    });
    logEvalInfo(
      logger,
      {
        apiKey: SECRET_KEY,
        systemPrompt: PROMPT,
        messages: [{ role: "user", content: PROMPT }],
        estimated_cost_usd: 0.01,
      },
      "ai-eval turn usage",
    );
    const output = chunks.join("");
    expect(output).not.toContain(SECRET_KEY);
    expect(output).not.toContain(PROMPT);
    expect(output).toContain("ai-eval turn usage");
  });
});
