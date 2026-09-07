/**
 * Anthropic staff-loop adapter (SHO-337 / SHO-508 / SHO-514).
 * The only `packages/ai/src` file that imports `@ai-sdk/anthropic`.
 *
 * Thinking is pinned off so a later default (Sonnet 5 adaptive) cannot
 * silently enable billed reasoning. Prompt-cache breakpoints mark the
 * stable prefix (system, and the last tool definition when tools are
 * attached) at 1h, and the per-conversation history prefix at 5m.
 */
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, ToolSet } from "ai";
import { z } from "zod";

import { StaffAssistantNotConfiguredError } from "../errors.js";
import type {
  StaffAssistantModelRates,
  StaffProviderAdapter,
  StaffProviderModelKind,
  StaffProviderToolDecoration,
} from "./types.js";

export const ANTHROPIC_STAFF_PROVIDER_ID = "anthropic" as const;

/** ToolSet key for Anthropic BM25 tool search (provider-executed). */
export const STAFF_ASSISTANT_TOOL_SEARCH_NAME = "tool_search_tool_bm25";

export const STAFF_ASSISTANT_THINKING_DISABLED = "disabled" as const;

export const STAFF_ASSISTANT_ANTHROPIC_THINKING = {
  type: STAFF_ASSISTANT_THINKING_DISABLED,
} as const;

export const STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS = {
  thinking: STAFF_ASSISTANT_ANTHROPIC_THINKING,
} as const;

/** 5-minute ephemeral breakpoint — Anthropic's default TTL for this type. */
export const STAFF_ASSISTANT_CACHE_CONTROL = {
  type: "ephemeral" as const,
  ttl: "5m" as const,
} as const;

/**
 * 1-hour ephemeral breakpoint for the static system + tools prefix.
 * Write cost is 2× base input (vs 1.25× for 5m); read cost is unchanged.
 */
export const STAFF_ASSISTANT_STATIC_CACHE_CONTROL = {
  type: "ephemeral" as const,
  ttl: "1h" as const,
} as const;

export const STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS = {
  anthropic: {
    cacheControl: STAFF_ASSISTANT_STATIC_CACHE_CONTROL,
  },
} as const;

export const STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS = {
  anthropic: {
    cacheControl: STAFF_ASSISTANT_CACHE_CONTROL,
  },
} as const;

/** Anthropic tool-search: load this tool into context only after a search hit. */
export const STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS = {
  anthropic: {
    deferLoading: true,
  },
} as const;

/**
 * Estimated staff-assistant spend from published Anthropic list prices.
 * Not billing-grade: logs and T2 budget admission only, never invoices.
 *
 * Rates: Anthropic API list (USD per million tokens), 2026-09.
 * Cache write is priced conservatively at 2× input (1h static-prefix
 * write). Mixed 1h (system + tools) and 5m (history) writes on one turn
 * are approximate and not billing-grade. Cache read is 0.1× input.
 */
export const STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK = {
  sonnet: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 6,
  },
  haiku: {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 2,
  },
  opus: {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 30,
  },
} as const;

export type StaffAssistantAnthropicRateTier =
  keyof typeof STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK;

export function staffAssistantAnthropicRateTier(
  modelId: string,
): StaffAssistantAnthropicRateTier | null {
  const id = modelId.toLowerCase();
  if (id.includes("opus")) {
    return "opus";
  }
  if (id.includes("haiku")) {
    return "haiku";
  }
  if (id.includes("sonnet")) {
    return "sonnet";
  }
  return null;
}

/**
 * Anthropic requires `input_schema.type`. Zod 4 discriminated unions
 * emit `oneOf` without a top-level `type`. Named object façades already
 * have `type: "object"` — do not flatten `*.contract.ts` to appease this.
 */
export function ensureAnthropicToolInputSchemaType(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof schema["type"] === "string") {
    return schema;
  }
  return { ...schema, type: "object" };
}

export interface AnthropicStaffProviderOptions {
  readonly apiKey?: string;
  readonly replyModel?: string;
  readonly gateModel?: string;
}

const DEFAULT_REPLY_MODEL = "claude-sonnet-4-6";
const DEFAULT_GATE_MODEL = "claude-haiku-4-5";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeferredTool(tool: { readonly providerOptions?: unknown }): boolean {
  if (!isRecord(tool.providerOptions)) {
    return false;
  }
  const anthropicOptions = tool.providerOptions["anthropic"];
  return (
    isRecord(anthropicOptions) && anthropicOptions["deferLoading"] === true
  );
}

function markLastNonDeferredToolCacheBreakpoint(tools: ToolSet): void {
  const names = Object.keys(tools);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const lastName = names[index];
    if (lastName === undefined) {
      continue;
    }
    const lastTool = tools[lastName];
    if (lastTool === undefined || isDeferredTool(lastTool)) {
      continue;
    }
    tools[lastName] = {
      ...lastTool,
      providerOptions: {
        ...lastTool.providerOptions,
        ...STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
      },
    };
    return;
  }
}

export function createAnthropicStaffProviderAdapter(
  options: AnthropicStaffProviderOptions = {},
): StaffProviderAdapter {
  const apiKey = options.apiKey;
  const replyModel = options.replyModel ?? DEFAULT_REPLY_MODEL;
  const gateModel = options.gateModel ?? DEFAULT_GATE_MODEL;

  return {
    id: ANTHROPIC_STAFF_PROVIDER_ID,
    createModel(kind: StaffProviderModelKind): LanguageModel {
      if (apiKey === undefined || apiKey === "") {
        throw new StaffAssistantNotConfiguredError();
      }
      const client = createAnthropic({ apiKey });
      return client(kind === "gate" ? gateModel : replyModel);
    },
    decorateToolSet(
      tools: ToolSet,
      decoration: StaffProviderToolDecoration,
    ): ToolSet {
      const hot = new Set(decoration.hot);
      const deferred = new Set(decoration.deferred);
      const decorated: ToolSet = {
        [STAFF_ASSISTANT_TOOL_SEARCH_NAME]:
          anthropic.tools.toolSearchBm25_20251119(),
      };
      for (const [name, tool] of Object.entries(tools)) {
        const defer = deferred.has(name) && !hot.has(name);
        decorated[name] = defer
          ? {
              ...tool,
              providerOptions: {
                ...tool.providerOptions,
                ...STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
              },
            }
          : tool;
      }
      markLastNonDeferredToolCacheBreakpoint(decorated);
      return decorated;
    },
    systemProviderOptions() {
      return STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS;
    },
    historyBreakpointOptions() {
      return STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS;
    },
    toolInputSchema(schema: z.ZodType) {
      return ensureAnthropicToolInputSchemaType({ ...z.toJSONSchema(schema) });
    },
    replyProviderOptions() {
      return { anthropic: STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS };
    },
    pricing(modelId: string): StaffAssistantModelRates | null {
      const tier = staffAssistantAnthropicRateTier(modelId);
      if (tier === null) {
        return null;
      }
      return STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK[tier];
    },
  };
}

/** Default Anthropic adapter for unit tests that omit an explicit instance. */
export const anthropicStaffProvider = createAnthropicStaffProviderAdapter();
