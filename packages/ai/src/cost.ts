/**
 * Estimated staff-assistant spend from the provider adapter's rate table.
 * Not billing-grade: logs and T2 budget admission only, never invoices.
 *
 * Unknown models return `null` — never a silent Sonnet fallback (SHO-508).
 * Assumption: `inputTokens` includes cache read and write counts the way
 * the provider reports them on the usage object.
 */
import { anthropicStaffProvider } from "./provider/anthropic.js";
import type { StaffProviderAdapter } from "./provider/types.js";
import type { StaffAssistantTurnUsage } from "./usage.js";

export {
  staffAssistantAnthropicRateTier,
  STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK,
  type StaffAssistantAnthropicRateTier,
} from "./provider/anthropic.js";

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * Split input into uncached / cache-read / cache-write and apply the
 * adapter rate table. Uncached = max(0, input − cacheRead − cacheWrite).
 * Returns `null` when `provider.pricing(modelId)` is `null`.
 */
export function estimateStaffAssistantCostUsd(
  usage: StaffAssistantTurnUsage,
  modelId: string,
  provider: StaffProviderAdapter = anthropicStaffProvider,
): number | null {
  const rates = provider.pricing(modelId);
  if (rates === null) {
    return null;
  }
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
  readonly provider?: StaffProviderAdapter;
}): number | null {
  const provider = options.provider ?? anthropicStaffProvider;
  const reply = estimateStaffAssistantCostUsd(
    options.reply,
    options.replyModelId,
    provider,
  );
  const gate = estimateStaffAssistantCostUsd(
    options.gate,
    options.gateModelId,
    provider,
  );
  if (reply === null || gate === null) {
    return null;
  }
  return roundUsd(reply + gate);
}
