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
  return mockToolCallsStream([{ toolCallId, toolName, input }]);
}

/** Several tool calls in one model step (sequential execute on the new host). */
export function mockToolCallsStream(
  calls: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: string;
  }[],
) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      ...calls.flatMap((call) => [
        {
          type: "tool-input-start" as const,
          id: call.toolCallId,
          toolName: call.toolName,
        },
        {
          type: "tool-input-delta" as const,
          id: call.toolCallId,
          delta: call.input,
        },
        { type: "tool-input-end" as const, id: call.toolCallId },
        {
          type: "tool-call" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        },
      ]),
      {
        type: "finish" as const,
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: MOCK_LANGUAGE_MODEL_USAGE,
      },
    ]),
  };
}
