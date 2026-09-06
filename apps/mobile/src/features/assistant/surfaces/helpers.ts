/**
 * Localized formatters for assistant result cards. Unlocalized parse
 * lives in `@showzy/validation/assistant-surfaces` (SHO-456).
 */
import {
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
  moneyMinorFromFields,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "@showzy/validation/assistant-surfaces";

import { formatMoneyMinor, groupDigits } from "../../../format/money";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import { toolNameFromPart } from "../shared/turn-timeline";

export { UNLINKED_CUSTOMER_NAME_SNAPSHOT };

const QUANTITY_MILLI_SCALE = 1000n;
const QUANTITY_WIRE = /^(0|[1-9][0-9]*)$/;

export function formatQuantityLabel(wire: unknown): string | null {
  if (typeof wire !== "string" || !QUANTITY_WIRE.test(wire)) {
    return null;
  }
  const milli = BigInt(wire);
  const units = milli / QUANTITY_MILLI_SCALE;
  const remainder = milli % QUANTITY_MILLI_SCALE;
  const grouped = groupDigits(units.toString(10));
  if (remainder === 0n) {
    return grouped;
  }
  const fraction = remainder.toString(10).padStart(3, "0").replace(/0+$/, "");
  return `${grouped},${fraction}`;
}

export function formatMoneyAmount(
  money: AssistantMoneyMinor | null,
): string | null {
  if (money === null) {
    return null;
  }
  try {
    return formatMoneyMinor(money.amountMinor, money.currency);
  } catch {
    return null;
  }
}

export function formatTotal(minor: unknown, currency: unknown): string | null {
  return formatMoneyAmount(moneyMinorFromFields(minor, currency));
}

export function localizeCustomerName(
  nameSnapshot: string | null,
  missingCustomer: string,
): string {
  if (
    nameSnapshot === null ||
    nameSnapshot.length === 0 ||
    nameSnapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT
  ) {
    return missingCustomer;
  }
  return nameSnapshot;
}

export function moneyLabels(
  amounts: readonly AssistantMoneyMinor[],
): readonly string[] {
  const labels: string[] = [];
  for (const amount of amounts) {
    const formatted = formatMoneyAmount(amount);
    if (formatted !== null) {
      labels.push(formatted);
    }
  }
  return labels;
}

/**
 * Chat-part adapter (SHO-456). The shared parse never sees a part: drop
 * non-tool parts, keep `state === "output-available"`, then map.
 */
export function assistantSurfaceToolResultsFromParts(
  parts: readonly AssistantChatPart[],
): readonly AssistantSurfaceToolResult[] {
  const results: AssistantSurfaceToolResult[] = [];
  for (const part of parts) {
    const toolName = toolNameFromPart(part);
    if (toolName === null) {
      continue;
    }
    if (part.state !== "output-available") {
      continue;
    }
    const toolCallId = part.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.length > 0) {
      results.push({ toolName, output: part.output, toolCallId });
      continue;
    }
    results.push({ toolName, output: part.output });
  }
  return results;
}
