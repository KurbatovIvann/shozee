/**
 * Read-time budget for reconstructed tool traces (SHO-510 / ADR-0034).
 * Storage keeps the post-clip façade output. History assembly applies
 * tiers: full trace for the most recent tool-bearing turn, a
 * deterministic identity digest for older turns, and 8 000 chars across
 * the window. Digests are not a model call.
 */
import type { JSONValue, ToolResultPart } from "ai";

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
  /**
   * Live ToolSet key (`orders_list_page`). Absent on rows recorded
   * before SHO-510 nits; reconstruction then falls back to `action`.
   */
  readonly toolName?: string | null;
  readonly modelTrace: unknown;
  /**
   * Façade/tool args. Absent/null on pre-T2 rows; reconstruction uses
   * `input: {}`.
   */
  readonly toolInput?: unknown;
  readonly seq?: number | null;
}

/** Reconstruct tool-call input. Pre-T2 rows without `toolInput` are `{}`. */
export function staffAssistantToolCallInput(
  run: Pick<StaffAssistantPersistedToolRun, "toolInput">,
): unknown {
  if (run.toolInput === undefined || run.toolInput === null) {
    return {};
  }
  return run.toolInput;
}

export interface StaffAssistantPersistedMessage {
  readonly role: "user" | "assistant";
  readonly body: string;
  readonly toolRuns?: readonly StaffAssistantPersistedToolRun[];
}

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
    if (!(key in value)) {
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

/** Digest / reconstruction name: façade ToolSet key when stored. */
export function staffAssistantToolSetKey(
  run: Pick<StaffAssistantPersistedToolRun, "action" | "toolName">,
): string {
  if (typeof run.toolName === "string" && run.toolName.length > 0) {
    return run.toolName;
  }
  return run.action;
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
  readonly toolName: string | null;
  /** Stored trace, kept so tier 1 can fall back to a digest of the original. */
  readonly storedTrace: unknown;
  readonly modelTrace: unknown;
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
 * Cap (ADR-0034 rule 3): drop oldest digests first, but only when that
 * can help. A tier-1 trace that alone exceeds the cap is shrunk and then
 * digested *before* the window is spent — deleting ≤ 300-char digests to
 * make room for a 20 000-char trace loses the window for nothing.
 *
 * Tier 1 is reduced rather than dropped, and because its digests are the
 * newest they are the last to go — but "last" is not "never". One turn may
 * hold more runs than the cap fits at all (`STAFF_ASSISTANT_TOOL_RUNS_MAX`
 * is 50, and 50 × ≤ 300 chars is over 8 000), and then tier-1 digests are
 * dropped oldest-first too until the window fits. That is the accepted
 * behaviour: the cap is hard, and a turn that called 50 tools cannot keep
 * every observation. Dropping clears the run's trace entirely so
 * reconstructed tool-call/result pairs stay valid.
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
      const toolName =
        typeof run.toolName === "string" && run.toolName.length > 0
          ? run.toolName
          : null;
      if (run.modelTrace === null || run.modelTrace === undefined) {
        return {
          action: run.action,
          toolCallId: run.toolCallId,
          toolName,
          storedTrace: null,
          modelTrace: null,
          kind: "omit" as const,
        };
      }
      if (tier === "digest") {
        return {
          action: run.action,
          toolCallId: run.toolCallId,
          toolName,
          storedTrace: run.modelTrace,
          modelTrace: staffAssistantTraceDigest(
            staffAssistantToolSetKey(run),
            run.modelTrace,
          ),
          kind: "digest" as const,
        };
      }
      return {
        action: run.action,
        toolCallId: run.toolCallId,
        toolName,
        storedTrace: run.modelTrace,
        modelTrace: run.modelTrace,
        kind: "full" as const,
      };
    });
  });

  const allRuns = (): BudgetedRun[] => budgeted.flat();

  const dropOldestKind = (kind: "digest"): boolean => {
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

  const overBudget = (): boolean =>
    budgetedChars(allRuns()) > STAFF_ASSISTANT_HISTORY_TRACE_MAX;

  const tierOneOverBudget = (): boolean =>
    budgetedChars(allRuns().filter((run) => run.kind === "full")) >
    STAFF_ASSISTANT_HISTORY_TRACE_MAX;

  const mapFullRuns = (next: (run: BudgetedRun) => BudgetedRun): void => {
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
        runs[index] = next(run);
      }
    }
  };

  /** Shrink, then digest — reduce tier 1 instead of dropping it outright. */
  const reduceTierOne = (stillTooBig: () => boolean): void => {
    if (stillTooBig()) {
      mapFullRuns((run) => ({
        ...run,
        modelTrace: shrinkFullTrace(run.modelTrace),
      }));
    }
    if (stillTooBig()) {
      mapFullRuns((run) => ({
        ...run,
        modelTrace: staffAssistantTraceDigest(
          staffAssistantToolSetKey(run),
          run.storedTrace,
        ),
        kind: "digest" as const,
      }));
    }
  };

  reduceTierOne(tierOneOverBudget);

  while (overBudget() && dropOldestKind("digest")) {
    // oldest digests first
  }

  reduceTierOne(overBudget);

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
        ...(run.toolName !== null ? { toolName: run.toolName } : {}),
        modelTrace: run.kind === "omit" ? null : run.modelTrace,
      })),
    };
  });
}

function toJsonValue(value: unknown): JSONValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
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
): ToolResultPart["output"] {
  if (typeof payload === "string") {
    return { type: "text", value: payload };
  }
  const json = toJsonValue(payload);
  if (json !== undefined) {
    return { type: "json", value: json };
  }
  return { type: "text", value: JSON.stringify(payload) };
}

export function staffAssistantToolResultChars(
  output: ToolResultPart["output"],
): number {
  if (output.type === "text") {
    return output.value.length;
  }
  if (output.type === "json") {
    return staffAssistantJsonChars(output.value);
  }
  return 0;
}
