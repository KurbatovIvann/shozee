import {
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  type LanguageModel,
  type ObservedToolCall,
} from "@showzy/ai";
import {
  generateText,
  stepCountIs,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";

import type { LlmUsage } from "../executor/llm.js";
import type { FollowupCase } from "./corpus.js";

export const REWRITE_SYSTEM_PROMPT = [
  "You prepare the latest message of a staff member of a small Ukrainian business for a downstream classifier that sees only that one message and none of the conversation.",
  "Rewrite the latest message as one self-contained Ukrainian request. Resolve pronouns and 'the same' from the conversation, and carry over what the message relies on but does not repeat: the job, the period, the order status, the customer, the products, quantities and prices.",
  "When the latest message answers the assistant's question, write the full request the answer completes.",
  "Keep names of people, groups, products and price lists exactly as written in the conversation. Write numbers as digits and put a quantity directly before its product.",
  "If the latest message already stands on its own, return it unchanged. Invent nothing. Output only the rewritten message.",
].join("\n");

const usageOf = (usage: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
}): LlmUsage => ({
  inputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
});

export function transcriptOf(probeCase: FollowupCase): string {
  const lines = probeCase.history.flatMap((exchange) => [
    `Staff: ${exchange.user}`,
    `Assistant: ${exchange.assistant}`,
  ]);
  return [
    "Conversation so far:",
    lines.length === 0 ? "(none)" : lines.join("\n"),
    "",
    "Latest message:",
    probeCase.message,
  ].join("\n");
}

export function messagesOf(probeCase: FollowupCase): ModelMessage[] {
  return [
    ...probeCase.history.flatMap((exchange, index): ModelMessage[] => {
      const toolCallId = `probe_call_${String(index)}`;
      return exchange.call === undefined
        ? [
            { role: "user", content: exchange.user },
            { role: "assistant", content: exchange.assistant },
          ]
        : [
            { role: "user", content: exchange.user },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId,
                  toolName: exchange.call.tool,
                  input: exchange.call.input,
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId,
                  toolName: exchange.call.tool,
                  output: { type: "json", value: exchange.call.output },
                },
              ],
            },
            { role: "assistant", content: exchange.assistant },
          ];
    }),
    { role: "user", content: probeCase.message },
  ];
}

export async function rewriteWithHistory(
  model: LanguageModel,
  probeCase: FollowupCase,
): Promise<{
  readonly text: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
}> {
  const startedAt = performance.now();
  const result = await generateText({
    model,
    system: REWRITE_SYSTEM_PROMPT,
    prompt: transcriptOf(probeCase),
    maxOutputTokens: 300,
  });
  return {
    text: result.text.trim(),
    usage: usageOf(result.usage),
    latencyMs: performance.now() - startedAt,
  };
}

export interface ToolLoopSetup {
  readonly system: SystemModelMessage[];
  readonly tools: ToolSet;
  readonly providerOptions: Parameters<
    typeof generateText
  >[0]["providerOptions"];
}

export async function firstCallInToolLoop(
  model: LanguageModel,
  setup: ToolLoopSetup,
  probeCase: FollowupCase,
): Promise<{
  readonly call: ObservedToolCall | undefined;
  readonly text: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
}> {
  const startedAt = performance.now();
  const result = await generateText({
    model,
    system: setup.system,
    messages: messagesOf(probeCase),
    tools: setup.tools,
    ...(setup.providerOptions === undefined
      ? {}
      : { providerOptions: setup.providerOptions }),
    stopWhen: [
      stepCountIs(3),
      ({ steps }) =>
        steps.some((step) =>
          step.toolCalls.some(
            (toolCall) =>
              toolCall.toolName !== STAFF_ASSISTANT_TOOL_SEARCH_NAME,
          ),
        ),
    ],
  });
  const first = result.steps
    .flatMap((step) => step.toolCalls)
    .find((toolCall) => toolCall.toolName !== STAFF_ASSISTANT_TOOL_SEARCH_NAME);
  return {
    call:
      first === undefined
        ? undefined
        : { toolName: first.toolName, input: first.input },
    text: result.text.trim(),
    usage: usageOf(result.usage),
    latencyMs: performance.now() - startedAt,
  };
}
