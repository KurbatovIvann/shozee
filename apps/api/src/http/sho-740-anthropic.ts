export interface Sho740ToolShape {
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  readonly providerOptions?: unknown;
}

export interface Sho740AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  cache_control?: { readonly type: "ephemeral" };
}

function jsonSchemaOf(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema !== "object" || inputSchema === null) {
    return { type: "object", properties: {} };
  }
  const nested = (inputSchema as { jsonSchema?: unknown }).jsonSchema;
  const schema = nested === undefined ? inputSchema : nested;
  if (typeof schema !== "object" || schema === null) {
    return { type: "object", properties: {} };
  }
  const record = { ...(schema as Record<string, unknown>) };
  delete record["$schema"];
  if (typeof record["type"] !== "string") {
    record["type"] = "object";
  }
  return record;
}

export function sho740AnthropicTools(
  tools: Readonly<Record<string, Sho740ToolShape>>,
  skip: readonly string[] = [],
): readonly Sho740AnthropicTool[] {
  const out: Sho740AnthropicTool[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (skip.includes(name)) {
      continue;
    }
    out.push({
      name,
      description:
        typeof tool.description === "string" ? tool.description : name,
      input_schema: jsonSchemaOf(tool.inputSchema),
    });
  }
  const last = out.at(-1);
  if (last !== undefined) {
    last.cache_control = { type: "ephemeral" };
  }
  return out;
}

export interface Sho740Message {
  readonly role: "user" | "assistant";
  readonly content: string | readonly Record<string, unknown>[];
}

export interface Sho740Reply {
  readonly toolCalled: string | null;
  readonly toolArgs: unknown;
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheWriteTokens: number;
    readonly cacheReadTokens: number;
  };
  readonly latencyMs: number;
  readonly error: string | null;
}

interface RawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

interface RawBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface RawReply {
  readonly content?: readonly RawBlock[];
  readonly stop_reason?: string;
  readonly usage?: RawUsage;
  readonly error?: { readonly message?: string };
}

export async function sho740Ask(input: {
  readonly apiKey: string;
  readonly model: string;
  readonly system: readonly Record<string, unknown>[];
  readonly tools: readonly Sho740AnthropicTool[];
  readonly messages: readonly Sho740Message[];
  readonly maxTokens?: number;
}): Promise<Sho740Reply> {
  const started = performance.now();
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": input.apiKey,
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens ?? 512,
        system: input.system,
        tools: input.tools,
        messages: input.messages,
      }),
    });
    const body = (await response.json()) as RawReply;
    const usage = {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
    };
    if (!response.ok) {
      return {
        toolCalled: null,
        toolArgs: null,
        text: "",
        stopReason: null,
        usage,
        latencyMs: performance.now() - started,
        error: `${String(response.status)} ${body.error?.message ?? "request failed"}`,
      };
    }
    const blocks = body.content ?? [];
    const call = blocks.find((block) => block.type === "tool_use");
    return {
      toolCalled: call?.name ?? null,
      toolArgs: call?.input ?? null,
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ")
        .trim(),
      stopReason: body.stop_reason ?? null,
      usage,
      latencyMs: performance.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      toolCalled: null,
      toolArgs: null,
      text: "",
      stopReason: null,
      usage: empty,
      latencyMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
