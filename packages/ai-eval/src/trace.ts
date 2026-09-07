import { isStaffAssistantSyntheticJsonTool } from "@showzy/ai";

import { isRecord } from "./record.js";

export interface EvalToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly result?: unknown;
}

function parseToolArgs(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function toolCallIdOf(payload: Record<string, unknown>): string | undefined {
  if (typeof payload["toolCallId"] === "string") {
    return payload["toolCallId"];
  }
  if (typeof payload["id"] === "string") {
    return payload["id"];
  }
  return undefined;
}

/**
 * Collect façade / provider tool calls from UI-message SSE. Skips the
 * synthetic `{ spoken }` json tool. Overlay `execute` results by
 * `toolCallId` when the provider does not stream them (`tool_search`).
 */
export function collectEvalToolCalls(
  payloads: readonly unknown[],
  executeResults: ReadonlyMap<string, unknown> = new Map(),
): EvalToolCall[] {
  const order: string[] = [];
  const byId = new Map<
    string,
    { name: string; args: unknown; result?: unknown }
  >();

  for (const payload of payloads) {
    if (!isRecord(payload) || typeof payload["type"] !== "string") {
      continue;
    }
    const type = payload["type"];
    if (type === "tool-input-available" || type === "tool-call") {
      const name =
        typeof payload["toolName"] === "string" ? payload["toolName"] : "";
      if (name === "" || isStaffAssistantSyntheticJsonTool(name)) {
        continue;
      }
      const toolCallId =
        toolCallIdOf(payload) ?? `${name}:${String(order.length)}`;
      if (!byId.has(toolCallId)) {
        order.push(toolCallId);
        byId.set(toolCallId, {
          name,
          args: parseToolArgs(payload["input"]),
        });
      }
      continue;
    }
    if (type === "tool-output-available" || type === "tool-result") {
      const toolCallId = toolCallIdOf(payload);
      if (toolCallId === undefined) {
        continue;
      }
      const existing = byId.get(toolCallId);
      if (existing !== undefined && payload["output"] !== undefined) {
        byId.set(toolCallId, { ...existing, result: payload["output"] });
      }
    }
  }

  const calls: EvalToolCall[] = [];
  for (const toolCallId of order) {
    const entry = byId.get(toolCallId);
    if (entry === undefined) {
      continue;
    }
    const executed = executeResults.get(toolCallId);
    const result = executed !== undefined ? executed : entry.result;
    calls.push({
      toolCallId,
      name: entry.name,
      args: entry.args,
      ...(result !== undefined ? { result } : {}),
    });
  }
  return calls;
}

/** Same SSE walk as `@showzy/ai/test` `readUiMessageSsePayloads`. */
async function readUiMessageSsePayloads(
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

export async function collectEvalToolCallsFromResponse(
  response: Response,
  executeResults?: ReadonlyMap<string, unknown>,
): Promise<{
  readonly payloads: unknown[];
  readonly toolCalls: EvalToolCall[];
}> {
  const payloads = await readUiMessageSsePayloads(response);
  return {
    payloads,
    toolCalls: collectEvalToolCalls(payloads, executeResults),
  };
}
