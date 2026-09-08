/**
 * Shared tool-run limits and result-id extraction for the staff assistant
 * host (ADR-0037). Persistence budgets, not envelope wire identity.
 */
import { z } from "zod";

import type { CommittedSpeech } from "./turn-speech.js";
import type { StaffAssistantTurnUsage } from "./usage.js";

export const STAFF_ASSISTANT_TOOL_RUNS_MAX = 50;
export const STAFF_ASSISTANT_RESULT_IDS_MAX = 50;
/** Persistence budget for `toolRuns` / executeAction — not envelope wire identity. */
export const STAFF_ASSISTANT_TOOL_CALL_ID_MAX = 128;
/**
 * Mechanical cap so a looping model cannot run unbounded tool steps.
 * Reply text is plain (SHO-507); structured output is not an extra step.
 */
export const STAFF_ASSISTANT_MAX_STEPS = 9;

const uuidSchema = z.uuid();

const RESULT_ID_KEYS = [
  "id",
  "orderId",
  "customerId",
  "documentId",
  "conversationId",
  "messageId",
  "requestId",
  "fileId",
] as const;

export type StaffAssistantToolRunOutcome =
  "success" | "error" | "confirmation_required" | "choice_required";

export interface StaffAssistantToolRun {
  readonly actionName: string;
  readonly toolCallId: string;
  readonly challengeId?: string;
  readonly resultIds: readonly string[];
  readonly outcome: StaffAssistantToolRunOutcome;
  /** Live ToolSet key from `clipToolExecutes` (`orders_list_page`). */
  readonly toolName?: string;
  readonly modelTrace?: unknown;
}

export interface StaffAssistantTurnResult {
  readonly speech: CommittedSpeech;
  readonly text: string;
  readonly toolRuns: readonly StaffAssistantToolRun[];
  readonly usage: StaffAssistantTurnUsage;
  readonly toolsAttached: boolean;
  readonly modelSteps: number;
  readonly toolResultBytesIn: number;
  readonly toolResultBytesOut: number;
  readonly toolsetHash: string;
  readonly historyMessageCount: number;
  readonly historyChars: number;
  readonly historyTraceChars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractUuidResultIds(output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const ids: string[] = [];
  for (const key of RESULT_ID_KEYS) {
    const value = output[key];
    if (typeof value === "string" && uuidSchema.safeParse(value).success) {
      ids.push(value);
    }
    if (ids.length >= STAFF_ASSISTANT_RESULT_IDS_MAX) {
      break;
    }
  }
  return ids;
}
