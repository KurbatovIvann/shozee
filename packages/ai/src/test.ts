/**
 * Test-only AI SDK helpers. Production code imports `@showzy/ai`, not this
 * subpath. HTTP tests inject MockLanguageModelV3 — no live LLM in CI.
 */
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";

export { convertArrayToReadableStream, MockLanguageModelV3 };

export const MOCK_LANGUAGE_MODEL_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export function mockGenerateObjectResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: MOCK_LANGUAGE_MODEL_USAGE,
    warnings: [],
  };
}

export function mockStaffAssistantGateGenerate(output: {
  readonly mode: "chitchat" | "capability" | "job";
  readonly intent?: "orders_page" | "orders_counts" | "orders_create" | "other";
  readonly confidence: "high" | "low";
}) {
  return mockGenerateObjectResult(JSON.stringify(output));
}

/** Maps the former boolean gate onto T3 shapes (full catalog vs chitchat). */
export function mockOperationalGateGenerate(operational: boolean) {
  return mockStaffAssistantGateGenerate(
    operational
      ? { mode: "job", intent: "other", confidence: "high" }
      : { mode: "chitchat", confidence: "high" },
  );
}

export function mockTextStream(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: text },
      { type: "text-end" as const, id: "t" },
      {
        type: "finish" as const,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: MOCK_LANGUAGE_MODEL_USAGE,
      },
    ]),
  };
}

/** Leftover `{ spoken }` envelope — invalid presentation after SHO-507. */
export function mockSpokenStream(spoken: string) {
  return mockTextStream(JSON.stringify({ spoken }));
}

/** Split plain-text deltas (JSON fragments or markdown dump). */
export function mockSplitTextStream(chunks: readonly string[]) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t" },
      ...chunks.map((delta) => ({
        type: "text-delta" as const,
        id: "t",
        delta,
      })),
      { type: "text-end" as const, id: "t" },
      {
        type: "finish" as const,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: MOCK_LANGUAGE_MODEL_USAGE,
      },
    ]),
  };
}

/**
 * Same-step tool call plus leftover `{ spoken }` JSON. Used when HITL
 * `stopWhen` would skip a later reply-only step.
 */
export function mockToolCallAndSpokenStream(
  toolCallId: string,
  toolName: string,
  input: string,
  spoken: string,
) {
  const payload = JSON.stringify({ spoken });
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      {
        type: "tool-input-start" as const,
        id: toolCallId,
        toolName,
      },
      {
        type: "tool-input-delta" as const,
        id: toolCallId,
        delta: input,
      },
      { type: "tool-input-end" as const, id: toolCallId },
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input,
      },
      { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: payload },
      { type: "text-end" as const, id: "t" },
      {
        type: "finish" as const,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: MOCK_LANGUAGE_MODEL_USAGE,
      },
    ]),
  };
}

export function mockToolCallStream(
  toolCallId: string,
  toolName: string,
  input: string,
) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-input-start" as const, id: toolCallId, toolName },
      { type: "tool-input-delta" as const, id: toolCallId, delta: input },
      { type: "tool-input-end" as const, id: toolCallId },
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input,
      },
      {
        type: "finish" as const,
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: MOCK_LANGUAGE_MODEL_USAGE,
      },
    ]),
  };
}

export async function readUiMessageSsePayloads(
  response: Response,
): Promise<unknown[]> {
  const text = await response.text();
  const payloads: unknown[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "));
    if (line === undefined) {
      continue;
    }
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      continue;
    }
    payloads.push(JSON.parse(data) as unknown);
  }
  return payloads;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Concatenate UI-message `text-delta` payloads (live bubble text). */
export function sseVisibleTextFromPayloads(
  payloads: readonly unknown[],
): string {
  const chunks: string[] = [];
  for (const payload of payloads) {
    if (!isRecord(payload) || payload["type"] !== "text-delta") {
      continue;
    }
    if (typeof payload["delta"] === "string") {
      chunks.push(payload["delta"]);
      continue;
    }
    if (typeof payload["text"] === "string") {
      chunks.push(payload["text"]);
    }
  }
  return chunks.join("");
}
