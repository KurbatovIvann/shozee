/**
 * Estimated staff-assistant spend from published Anthropic list prices.
 * Not billing-grade: logs and T2 budget admission only, never invoices.
 *
 * Rates: Anthropic API list (USD per million tokens), 2026-09.
 * Cache write is priced conservatively at 2× input (1h static-prefix
 * write). Mixed 1h (system + tools) and 5m (history) writes on one turn
 * are approximate and not billing-grade. Cache read is 0.1× input.
 * Assumption: `inputTokens` includes cache read and write counts the
 * way Anthropic reports them on the usage object.
 */
import type { StaffAssistantTurnUsage } from "./usage.js";

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
} as const;

export type StaffAssistantAnthropicRateTier =
  keyof typeof STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK;

export function staffAssistantAnthropicRateTier(
  modelId: string,
): StaffAssistantAnthropicRateTier {
  return modelId.toLowerCase().includes("haiku") ? "haiku" : "sonnet";
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * Split input into uncached / cache-read / cache-write and apply the
 * rate table. Uncached = max(0, input − cacheRead − cacheWrite).
 */
export function estimateStaffAssistantCostUsd(
  usage: StaffAssistantTurnUsage,
  modelId: string,
): number {
  const rates =
    STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK[
      staffAssistantAnthropicRateTier(modelId)
    ];
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const usd =
    (uncachedInput * rates.input +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite +
      usage.outputTokens * rates.output) /
    1_000_000;
  return roundUsd(usd);
}

export function estimateStaffAssistantTurnCostUsd(options: {
  readonly reply: StaffAssistantTurnUsage;
  readonly replyModelId: string;
  readonly gate: StaffAssistantTurnUsage;
  readonly gateModelId: string;
}): number {
  return roundUsd(
    estimateStaffAssistantCostUsd(options.reply, options.replyModelId) +
      estimateStaffAssistantCostUsd(options.gate, options.gateModelId),
  );
}
