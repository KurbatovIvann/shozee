/**
 * Neutral assistant-surface helpers (SHO-456). Raw values only — no
 * labels, money formatting, or i18n. Cards stay a projection of live
 * tool output (ADR-0011).
 */

export const ASSISTANT_TOOL_CLIPPED_STATUS = "clipped" as const;

export const ASSISTANT_TOOL_NON_RESULT_STATUSES = [
  "error",
  "confirmation_required",
  "needs_choice",
] as const;

export type AssistantToolNonResultStatus =
  (typeof ASSISTANT_TOOL_NON_RESULT_STATUSES)[number];

export type AssistantClippedToolEnvelope = {
  readonly status: typeof ASSISTANT_TOOL_CLIPPED_STATUS;
  readonly preview: unknown;
  readonly omitted: number;
};

export type AssistantSurfaceToolResult = {
  readonly toolName: string;
  readonly output: unknown;
  readonly toolCallId?: string;
};

export type AssistantMoneyMinor = {
  readonly amountMinor: string;
  readonly currency: string;
};

/** Protocol sentinel on order/customer snapshots — not UI copy. */
export const UNLINKED_CUSTOMER_NAME_SNAPSHOT = "unlinked";

const QUANTITY_WIRE = /^(0|[1-9][0-9]*)$/;

const NON_RESULT_STATUS = new Set<string>(ASSISTANT_TOOL_NON_RESULT_STATUSES);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAssistantClippedToolEnvelope(
  value: unknown,
): value is AssistantClippedToolEnvelope {
  return isRecord(value) && value["status"] === ASSISTANT_TOOL_CLIPPED_STATUS;
}

/**
 * A tool output is a renderable result when its `status` is not one of
 * the named non-result envelope statuses. `clipped` is a result that
 * must be unwrapped. `code` plays no part. An unknown `status` is not
 * rejected.
 */
export function isAssistantSurfaceResultOutput(output: unknown): boolean {
  if (output === undefined) {
    return false;
  }
  if (!isRecord(output)) {
    return true;
  }
  const status = output["status"];
  if (typeof status !== "string") {
    return true;
  }
  return !NON_RESULT_STATUS.has(status);
}

export function unwrapToolOutput(output: unknown): {
  readonly payload: unknown;
  readonly clipped: boolean;
} {
  if (isAssistantClippedToolEnvelope(output)) {
    return { payload: output.preview, clipped: true };
  }
  return { payload: output, clipped: false };
}

export function lastSuccessfulResult(
  results: readonly AssistantSurfaceToolResult[],
  matches: (toolName: string) => boolean,
): AssistantSurfaceToolResult | null {
  let found: AssistantSurfaceToolResult | null = null;
  for (const result of results) {
    if (!matches(result.toolName)) {
      continue;
    }
    if (!isAssistantSurfaceResultOutput(result.output)) {
      continue;
    }
    found = result;
  }
  return found;
}

export function moneyMinorFromFields(
  minor: unknown,
  currency: unknown,
): AssistantMoneyMinor | null {
  if (typeof minor !== "string" || typeof currency !== "string") {
    return null;
  }
  if (currency.length !== 3) {
    return null;
  }
  return { amountMinor: minor, currency };
}

export function grossAmounts(value: unknown): readonly AssistantMoneyMinor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const amounts: AssistantMoneyMinor[] = [];
  for (const row of value) {
    if (!isRecord(row)) {
      continue;
    }
    const money = moneyMinorFromFields(
      row["grossAmountMinor"],
      row["currency"],
    );
    if (money !== null) {
      amounts.push(money);
    }
  }
  return amounts;
}

export function quantityMilliWire(value: unknown): string | null {
  if (typeof value !== "string" || !QUANTITY_WIRE.test(value)) {
    return null;
  }
  return value;
}

/**
 * Raw `nameSnapshot` from a payload `customer` object.
 * `null` — no customer object. `""` — present but empty snapshot.
 * `"unlinked"` is the protocol sentinel.
 */
export function customerNameSnapshotFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const customer = payload["customer"];
  if (!isRecord(customer)) {
    return null;
  }
  const nameSnapshot = customer["nameSnapshot"];
  if (typeof nameSnapshot !== "string" || nameSnapshot.length === 0) {
    return "";
  }
  return nameSnapshot;
}
