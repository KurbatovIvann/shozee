import {
  STAFF_ASSISTANT_RECORD_SHAPES,
  type StaffAssistantRecordShape,
} from "@showzy/ai";
import type { ModelMessage } from "@showzy/assistant-kit";
import {
  shoCommandSchema,
  shoFocusEntrySchema,
  SHO_MOST_FOCUS,
  SHO_UNRECOGNIZED,
  type ShoCommand,
  type ShoFocusEntry,
  type ShoPrevious,
  type ShoRecordType,
  type ShoRef,
} from "@showzy/sho-protocol";
import { z } from "zod";

import { shoWrites } from "./sho-plan.js";
import { shoIsRef } from "./sho-planners/kit.js";

export const SHO_LOG_NAMESPACE = "sho";
export const SHO_LOG_FIELD = "turn";

export const shoFocusRecordSchema = shoFocusEntrySchema.omit({
  turns: true,
  earlier: true,
});

export const shoTurnLogSchema = z.object({
  command: shoCommandSchema,
  sessionId: z.string(),
  at: z.string(),
});

export type ShoFocusRecord = z.infer<typeof shoFocusRecordSchema>;
export type ShoTurnLog = z.infer<typeof shoTurnLogSchema>;

export const SHO_FOCUS_PARAM_TYPES: Readonly<Record<string, ShoRecordType>> = {
  customer: "customer",
  group: "group",
  order_number: "order",
  product: "product",
  price_list: "price_list",
  counterparty: "counterparty",
};

const focusKey = (type: ShoRecordType, id: string): string =>
  `${type}\u0000${id}`;

type Json = Readonly<Record<string, unknown>>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, key: string): string | null {
  if (!isJson(value)) {
    return null;
  }
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : null;
}

interface Seen {
  readonly id: string;
  readonly name: string;
}

function viewOf(value: unknown, shape: StaffAssistantRecordShape): Seen | null {
  const id = text(value, shape.idKey);
  const name = text(value, shape.nameKey);
  return id === null ? null : { id, name: name ?? "" };
}

function rowsOf(
  value: unknown,
  shape: StaffAssistantRecordShape,
): readonly unknown[] | null {
  if (shape.rowsKey === null || !isJson(value)) {
    return null;
  }
  const rows = value[shape.rowsKey];
  return Array.isArray(rows) ? rows : null;
}

function namedIn(command: ShoCommand): readonly ShoFocusRecord[] {
  const named: ShoFocusRecord[] = [];
  for (const [path, param] of Object.entries(command.params)) {
    const type = SHO_FOCUS_PARAM_TYPES[path];
    if (type === undefined || !shoIsRef(param) || param.status !== "resolved") {
      continue;
    }
    const ref = param;
    const id = ref.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    named.push({ type, id, name: ref.name ?? ref.text, how: "named" });
  }
  return named;
}

function ranOf(
  toolName: string,
  result: unknown,
): readonly ShoFocusRecord[] | null {
  const shape = STAFF_ASSISTANT_RECORD_SHAPES[toolName];
  if (shape === undefined) {
    return null;
  }
  const type: ShoRecordType = shape.kind;
  const rows = rowsOf(result, shape);
  if (rows === null) {
    const seen = viewOf(result, shape);
    return seen === null
      ? null
      : [{ type, id: seen.id, name: seen.name, how: "shown" }];
  }
  const only = rows.length === 1 ? viewOf(rows[0], shape) : null;
  return only === null
    ? [{ type, id: "", name: "", how: "listed", count: rows.length }]
    : [{ type, id: only.id, name: only.name, how: "listed" }];
}

interface Creates {
  readonly type: ShoRecordType;
  readonly name: string | null;
}

function madeBy(
  creates: Creates,
  toolName: string,
  result: unknown,
): ShoFocusRecord {
  const shape = STAFF_ASSISTANT_RECORD_SHAPES[toolName];
  const made = shape === undefined ? null : viewOf(result, shape);
  return {
    type: creates.type,
    id: made?.id ?? "",
    name: creates.name ?? made?.name ?? "",
    how: "created",
  };
}

const createsOf = (command: ShoCommand): Creates | null => {
  const creates = command.creates;
  return creates === undefined || creates.type === SHO_UNRECOGNIZED
    ? null
    : { type: creates.type, name: creates.name };
};

export function shoTurnRecords(
  command: ShoCommand,
  toolName: string,
  result: unknown,
): readonly ShoFocusRecord[] {
  const creates = createsOf(command);
  const ran =
    creates === null
      ? (ranOf(toolName, result) ?? [])
      : [madeBy(creates, toolName, result)];
  return [...ran, ...namedIn(command)].slice(0, SHO_MOST_FOCUS);
}

interface Referred {
  readonly path: string;
  readonly ref: ShoRef;
}

function refsInto(path: string, value: unknown, into: Referred[]): void {
  if (shoIsRef(value)) {
    into.push({ path, ref: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      refsInto(path, entry, into);
    }
    return;
  }
  if (!isJson(value)) {
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    refsInto(key, field, into);
  }
}

function shoCommandRefs(command: ShoCommand): readonly Referred[] {
  const refs: Referred[] = [];
  for (const [path, param] of Object.entries(command.params)) {
    refsInto(path, param, refs);
  }
  return refs;
}

export function shoFocusHolds(
  command: ShoCommand,
  focus: readonly ShoFocusEntry[],
): boolean {
  const heldAs = new Set(focus.map((entry) => focusKey(entry.type, entry.id)));
  const heldIds = new Set(focus.map((entry) => entry.id));
  for (const { path, ref } of shoCommandRefs(command)) {
    const id = ref.id;
    if (ref.status !== "context" || typeof id !== "string" || id.length === 0) {
      continue;
    }
    const expected = SHO_FOCUS_PARAM_TYPES[path];
    const holds =
      expected === undefined
        ? heldIds.has(id)
        : heldAs.has(focusKey(expected, id));
    if (!holds) {
      return false;
    }
  }
  return true;
}

export function shoLogOptions(log: ShoTurnLog): {
  readonly [SHO_LOG_NAMESPACE]: { readonly [SHO_LOG_FIELD]: string };
} {
  return { [SHO_LOG_NAMESPACE]: { [SHO_LOG_FIELD]: JSON.stringify(log) } };
}

function written(message: ModelMessage): unknown {
  const options = message.providerOptions?.[SHO_LOG_NAMESPACE];
  const value = options === undefined ? undefined : options[SHO_LOG_FIELD];
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

interface Ran {
  readonly toolCallId: string;
  readonly toolName: string;
}

function calledIn(message: ModelMessage): Ran | null {
  if (message.role !== "assistant" || typeof message.content === "string") {
    return null;
  }
  for (const part of message.content) {
    if (part.type === "tool-call") {
      return { toolCallId: part.toolCallId, toolName: part.toolName };
    }
  }
  return null;
}

function resultIn(
  history: readonly ModelMessage[],
  after: number,
  toolCallId: string,
): unknown {
  for (let index = after + 1; index < history.length; index += 1) {
    const message = history[index];
    if (message === undefined || message.role !== "tool") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        return part.output.type === "json" ? part.output.value : undefined;
      }
    }
  }
  return undefined;
}

const stillPaused = (result: unknown): boolean =>
  isJson(result) && result["status"] === "paused";

function recordsOf(
  command: ShoCommand,
  toolName: string,
  result: unknown,
): readonly ShoFocusRecord[] {
  return stillPaused(result)
    ? namedIn(command)
    : shoTurnRecords(command, toolName, result);
}

interface Touched {
  readonly log: ShoTurnLog;
  readonly records: readonly ShoFocusRecord[];
  readonly turns: number;
}

function shoLogs(history: readonly ModelMessage[]): readonly Touched[] {
  const touched: Touched[] = [];
  let turns = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "user") {
      turns += 1;
      continue;
    }
    const parsed = shoTurnLogSchema.safeParse(written(message));
    const ran = calledIn(message);
    if (!parsed.success || ran === null) {
      continue;
    }
    touched.push({
      log: parsed.data,
      turns,
      records: recordsOf(
        parsed.data.command,
        ran.toolName,
        resultIn(history, index, ran.toolCallId),
      ),
    });
  }
  return touched;
}

export function shoFocusFrom(
  history: readonly ModelMessage[],
  sessionId: string,
): readonly ShoFocusEntry[] {
  const held = new Set<string>();
  const focus: ShoFocusEntry[] = [];
  for (const { log, records, turns } of shoLogs(history)) {
    const earlier =
      log.sessionId === sessionId ? {} : { earlier: true as const };
    for (const record of records) {
      const key = focusKey(record.type, record.id);
      if (held.has(key)) {
        continue;
      }
      held.add(key);
      focus.push({ ...record, turns, ...earlier });
      if (focus.length === SHO_MOST_FOCUS) {
        return focus;
      }
    }
  }
  return focus;
}

export function shoPreviousFrom(
  history: readonly ModelMessage[],
): ShoPrevious | undefined {
  const [newest] = shoLogs(history);
  if (newest === undefined) {
    return undefined;
  }
  const { command, at } = newest.log;
  return shoWrites(command) ? undefined : { command, at };
}
