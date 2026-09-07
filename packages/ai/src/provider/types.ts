import type { JSONValue, LanguageModel, ToolSet } from "ai";
import type { z } from "zod";

/** USD per million tokens. Cache write is the adapter's admission rate. */
export interface StaffAssistantModelRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type StaffProviderModelKind = "reply" | "gate";

export interface StaffProviderToolDecoration {
  readonly hot: readonly string[];
  readonly deferred: readonly string[];
}

/** AI SDK `providerOptions` (`Record<string, JSONObject>`). */
export type StaffProviderCallOptions = Record<
  string,
  { [key: string]: JSONValue }
>;

/**
 * Provider-specific staff-loop surface (SHO-508). `apps/api` constructs
 * one instance from config and passes it in. Not a registry, not DI.
 */
export interface StaffProviderAdapter {
  readonly id: string;
  createModel(kind: StaffProviderModelKind): LanguageModel;
  decorateToolSet(
    tools: ToolSet,
    options: StaffProviderToolDecoration,
  ): ToolSet;
  systemProviderOptions(): StaffProviderCallOptions;
  historyBreakpointOptions(): StaffProviderCallOptions;
  toolInputSchema(schema: z.ZodType): Record<string, unknown>;
  replyProviderOptions(): StaffProviderCallOptions;
  pricing(modelId: string): StaffAssistantModelRates | null;
}
