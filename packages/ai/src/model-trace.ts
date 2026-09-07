/**
 * Read-time budget for reconstructed tool traces (SHO-510 / ADR-0034).
 * Storage keeps the post-clip façade output. History assembly applies
 * tiers: full trace for the most recent tool-bearing turn, a
 * deterministic identity digest for older turns, and 8 000 chars across
 * the window. Digests are not a model call.
 */
import type { JSONValue, ToolResultOutput } from "ai";

import {
  compactStaffAssistantTraceIdentity,
  shrinkStaffAssistantTracePreview,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_IDENTITY_KEYS,
  STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX,
} from "./clip-tool-result.js";
import { staffAssistantJsonChars } from "./json-chars.js";

export const STAFF_ASSISTANT_TRACE_DIGEST_MAX = 300;
export const STAFF_ASSISTANT_HISTORY_TRACE_MAX = 8_000;

export interface StaffAssistantPersistedToolRun {
  readonly action: string;
  readonly toolCallId: string;
  readonly modelTrace: unknown | null;
}

export interface StaffAssistantPersistedMessage {
  readonly role: "user" | "assistant";
  readonly body: string;
  readonly toolRuns?: readonly StaffAssistantPersistedToolRun[];
}

const IDENTITY_KEY_SET = new Set<string>(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapClippedTrace(trace: unknown): unknown {
  if (
    isRecord(trace) &&
    trace["status"] === STAFF_ASSISTANT_CLIPPED_STATUS &&
    "preview" in trace
  ) {
    return trace["preview"];
  }
  return trace;
}

function nestedIdentityName(
  value: Record<string, unknown>,
): string | undefined {
  const customer = value["customer"];
  if (isRecord(customer) && typeof customer["nameSnapshot"] === "string") {
    return customer["nameSnapshot"];
  }
  return undefined;
}

function formatRowLabel(value: unknown): string {
  if (!isRecord(value)) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
    return "";
  }
  const numberValue = value["orderNumber"] ?? value["id"] ?? value["orderId"];
  const number =
    typeof numberValue === "string" || typeof numberValue === "number"
      ? String(numberValue)
      : undefined;
  const nameValue = value["name"] ?? value["titleSnapshot"];
  const name =
    typeof nameValue === "string" ? nameValue : nestedIdentityName(value);
  const bits: string[] = [];
  if (number !== undefined && number !== "") {
    bits.push(number.startsWith("#") ? number : `#${number}`);
  }
  if (name !== undefined && name !== "") {
    bits.push(`(${name})`);
  }
  if (typeof value["status"] === "string" && value["status"] !== "") {
    bits.push(value["status"]);
  }
  if (bits.length > 0) {
    return bits.join(" ");
  }
  const identityBits: string[] = [];
  for (const key of STAFF_ASSISTANT_CLIP_IDENTITY_KEYS) {
    if (!IDENTITY_KEY_SET.has(key) || !(key in value)) {
      continue;
    }
    const entry = value[key];
    if (typeof entry === "string" && entry !== "") {
      identityBits.push(entry);
    }
    if (identityBits.length >= 2) {
      break;
    }
  }
  return identityBits.join(" ");
}

function collectDigestRows(trace: unknown): unknown[] {
  const unwrapped = unwrapClippedTrace(trace);
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }
  if (!isRecord(unwrapped)) {
    return [];
  }
  for (const key of ["rows", "items", "orders", "customers", "products"]) {
    const entry = unwrapped[key];
    if (Array.isArray(entry)) {
      return entry;
    }
  }
  return [unwrapped];
}

/** Deterministic one-line digest. No model call. */
export function staffAssistantTraceDigest(
  action: string,
  trace: unknown,
): string {
  const rows = collectDigestRows(trace);
  const labels = rows
    .map(formatRowLabel)
    .filter((label) => label !== "")
    .slice(0, STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX);
  const count = rows.length;
  const noun = count === 1 ? "result" : "results";
  const listed = labels.join(", ");
  const body =
    listed === "" ? String(count) : `${String(count)} ${noun}: ${listed}`;
  const line = `${action} → ${body}`;
  return line.length <= STAFF_ASSISTANT_TRACE_DIGEST_MAX
    ? line
    : line.slice(0, STAFF_ASSISTANT_TRACE_DIGEST_MAX);
}

function payloadChars(payload: unknown): number {
  if (typeof payload === "string") {
    return payload.length;
  }
  return staffAssistantJsonChars(payload);
}

function shrinkFullTrace(trace: unknown): unknown {
  const shrunk = shrinkStaffAssistantTracePreview(trace);
  if (payloadChars(shrunk) < payloadChars(trace)) {
    return shrunk;
  }
  return compactStaffAssistantTraceIdentity(trace);
}

function hasStoredTrace(message: StaffAssistantPersistedMessage): boolean {
  if (message.role !== "assistant" || message.toolRuns === undefined) {
    return false;
  }
  return message.toolRuns.some(
    (run) => run.modelTrace !== null && run.modelTrace !== undefined,
  );
}

type BudgetedRun = {
  readonly action: string;
  readonly toolCallId: string;
  readonly modelTrace: unknown | null;
  readonly kind: "full" | "digest" | "omit";
};

function budgetedChars(runs: readonly BudgetedRun[]): number {
  let chars = 0;
  for (const run of runs) {
    if (run.kind === "omit" || run.modelTrace === null) {
      continue;
    }
    chars += payloadChars(run.modelTrace);
  }
  return chars;
}

/**
 * Tier 1: full trace on the last tool-bearing assistant turn.
 * Tier 2: digest on older tool-bearing turns.
 * Cap: drop oldest digests first, then shrink tier 1, then drop oldest
 * remaining traces so reconstructed tool-call/result pairs stay valid.
 */
export function budgetStaffAssistantToolRuns(
  messages: readonly StaffAssistantPersistedMessage[],
): StaffAssistantPersistedMessage[] {
  let lastToolIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && hasStoredTrace(message)) {
      lastToolIndex = index;
    }
  }

  const budgeted: BudgetedRun[][] = messages.map((message, index) => {
    const runs = message.toolRuns ?? [];
    const tier: "full" | "digest" = index === lastToolIndex ? "full" : "digest";
    return runs.map((run) => {
      if (run.modelTrace === null || run.modelTrace === undefined) {
        return {
          action: run.action,
          toolCallId: run.toolCallId,
          modelTrace: null,
          kind: "omit" as const,
        };
      }
      if (tier === "digest") {
        return {
          action: run.action,
          toolCallId: run.toolCallId,
          modelTrace: staffAssistantTraceDigest(run.action, run.modelTrace),
          kind: "digest" as const,
        };
      }
      return {
        action: run.action,
        toolCallId: run.toolCallId,
        modelTrace: run.modelTrace,
        kind: "full" as const,
      };
    });
  });

  const allRuns = (): BudgetedRun[] => budgeted.flat();

  const dropOldestKind = (kind: "digest" | "full"): boolean => {
    for (const runs of budgeted) {
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        if (run === undefined || run.kind !== kind) {
          continue;
        }
        runs[index] = { ...run, modelTrace: null, kind: "omit" };
        return true;
      }
    }
    return false;
  };

  while (
    budgetedChars(allRuns()) > STAFF_ASSISTANT_HISTORY_TRACE_MAX &&
    dropOldestKind("digest")
  ) {
    // oldest digests first
  }

  if (budgetedChars(allRuns()) > STAFF_ASSISTANT_HISTORY_TRACE_MAX) {
    for (const runs of budgeted) {
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index];
        if (
          run === undefined ||
          run.kind !== "full" ||
          run.modelTrace === null
        ) {
          continue;
        }
        runs[index] = {
          ...run,
          modelTrace: shrinkFullTrace(run.modelTrace),
        };
      }
    }
  }

  while (
    budgetedChars(allRuns()) > STAFF_ASSISTANT_HISTORY_TRACE_MAX &&
    dropOldestKind("full")
  ) {
    // last resort: drop oldest remaining full traces
  }

  return messages.map((message, index) => {
    const runs = budgeted[index];
    if (runs === undefined || message.role === "user") {
      return {
        role: message.role,
        body: message.body,
        ...(message.toolRuns !== undefined ? { toolRuns: [] } : {}),
      };
    }
    return {
      role: message.role,
      body: message.body,
      toolRuns: runs.map((run) => ({
        action: run.action,
        toolCallId: run.toolCallId,
        modelTrace: run.kind === "omit" ? null : run.modelTrace,
      })),
    };
  });
}

function toJsonValue(value: unknown): JSONValue | undefined {
  if (value === null) {
    return null;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return value;
  }
  if (kind === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: JSONValue[] = [];
    for (const item of value) {
      const converted = toJsonValue(item);
      if (converted === undefined) {
        return undefined;
      }
      items.push(converted);
    }
    return items;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const record: { [key: string]: JSONValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    const converted = toJsonValue(entry);
    if (converted === undefined) {
      return undefined;
    }
    record[key] = converted;
  }
  return record;
}

export function staffAssistantToolResultOutput(
  payload: unknown,
): ToolResultOutput {
  if (typeof payload === "string") {
    return { type: "text", value: payload };
  }
  const json = toJsonValue(payload);
  if (json !== undefined) {
    return { type: "json", value: json };
  }
  const encoded = JSON.stringify(payload);
  return { type: "text", value: encoded === undefined ? "null" : encoded };
}

export function staffAssistantToolResultChars(
  output: ToolResultOutput,
): number {
  if (output.type === "text") {
    return output.value.length;
  }
  if (output.type === "json") {
    return staffAssistantJsonChars(output.value);
  }
  return 0;
}
