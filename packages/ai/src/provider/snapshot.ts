import type { Tool, ToolSet } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotTool(tool: Tool): unknown {
  const record = tool as unknown as Record<string, unknown>;
  return {
    description: tool.description ?? null,
    providerOptions: tool.providerOptions ?? null,
    type: record["type"] ?? null,
    id: record["id"] ?? null,
  };
}

/**
 * Stable JSON of providerOptions + advertised ToolSet fields (no execute).
 * Used to prove the Anthropic adapter is a move, not a behaviour change.
 */
export function snapshotStaffProviderSurface(options: {
  readonly system: unknown;
  readonly history: unknown;
  readonly reply: unknown;
  readonly tools: ToolSet;
}): string {
  const tools: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(options.tools)) {
    if (tool === undefined) {
      continue;
    }
    tools[name] = snapshotTool(tool);
  }
  const payload = {
    system: options.system,
    history: options.history,
    reply: options.reply,
    toolNames: Object.keys(options.tools),
    tools,
  };
  if (!isRecord(payload)) {
    return "{}\n";
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}
