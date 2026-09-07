/**
 * Log-facing token counters for a staff assistant turn. Never includes
 * prompts, tool payloads, or API keys.
 */
export interface StaffAssistantTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const EMPTY_STAFF_ASSISTANT_TURN_USAGE: StaffAssistantTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedInputCounts(value: unknown):
  | {
      total: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    !("total" in value) &&
    !("cacheRead" in value) &&
    !("cacheWrite" in value)
  ) {
    return undefined;
  }
  return {
    total: finiteNumber(value["total"]),
    cacheRead: finiteNumber(value["cacheRead"]),
    cacheWrite: finiteNumber(value["cacheWrite"]),
  };
}

function nestedOutputTotal(value: unknown): number | undefined {
  if (!isRecord(value) || !("total" in value)) {
    return undefined;
  }
  return finiteNumber(value["total"]);
}

/**
 * Map AI SDK usage onto the four counters the HTTP mount logs. Accepts
 * both flattened `LanguageModelUsage` and nested V3/V4 mock usage.
 */
export function staffAssistantTurnUsageFromUnknown(
  usage: unknown,
): StaffAssistantTurnUsage {
  if (!isRecord(usage)) {
    return EMPTY_STAFF_ASSISTANT_TURN_USAGE;
  }

  const nestedInput = nestedInputCounts(usage["inputTokens"]);
  if (nestedInput !== undefined) {
    return {
      inputTokens: nestedInput.total,
      outputTokens:
        nestedOutputTotal(usage["outputTokens"]) ??
        finiteNumber(usage["outputTokens"]),
      cacheReadTokens: nestedInput.cacheRead,
      cacheWriteTokens: nestedInput.cacheWrite,
    };
  }

  const details = isRecord(usage["inputTokenDetails"])
    ? usage["inputTokenDetails"]
    : {};

  return {
    inputTokens: finiteNumber(usage["inputTokens"]),
    outputTokens: finiteNumber(usage["outputTokens"]),
    cacheReadTokens: finiteNumber(details["cacheReadTokens"]),
    cacheWriteTokens: finiteNumber(details["cacheWriteTokens"]),
  };
}

export async function staffAssistantTurnUsageFromTotal(
  totalUsage: PromiseLike<unknown>,
): Promise<StaffAssistantTurnUsage> {
  try {
    return staffAssistantTurnUsageFromUnknown(await totalUsage);
  } catch {
    return EMPTY_STAFF_ASSISTANT_TURN_USAGE;
  }
}

export function staffAssistantUncachedInputTokens(
  usage: StaffAssistantTurnUsage,
): number {
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens);
}

export function staffAssistantCacheHitRatio(
  usage: StaffAssistantTurnUsage,
): number {
  if (usage.inputTokens <= 0) {
    return 0;
  }
  return usage.cacheReadTokens / usage.inputTokens;
}

/**
 * Log fields for estimated spend. Unknown models stay unknown — never a
 * silent Sonnet fallback (SHO-508).
 */
export function staffAssistantCostLogFields(estimatedCostUsd: number | null): {
  readonly estimated_cost_usd: number | null;
  readonly cost_known: boolean;
} {
  return {
    estimated_cost_usd: estimatedCostUsd,
    cost_known: estimatedCostUsd !== null,
  };
}
