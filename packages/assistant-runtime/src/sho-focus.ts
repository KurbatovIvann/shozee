import type { ModelMessage } from "@showzy/assistant-kit";
import {
  shoCommandSchema,
  shoFocusEntrySchema,
  SHO_MOST_FOCUS,
  SHO_UNRECOGNIZED,
  type ShoCommand,
  type ShoFocusEntry,
  type ShoParam,
  type ShoPrevious,
  type ShoRecordType,
  type ShoRef,
} from "@showzy/sho-protocol";
import { z } from "zod";

import { shoWrites } from "./sho-plan.js";

export const SHO_LOG_NAMESPACE = "sho";
export const SHO_LOG_FIELD = "turn";

export const shoFocusRecordSchema = shoFocusEntrySchema.omit({
  turns: true,
  earlier: true,
});

export const shoTurnLogSchema = z.object({
  command: shoCommandSchema,
  records: z.array(shoFocusRecordSchema).max(SHO_MOST_FOCUS),
  sessionId: z.string(),
  at: z.string(),
  open: z.boolean(),
});

export type ShoFocusRecord = z.infer<typeof shoFocusRecordSchema>;
export type ShoTurnLog = z.infer<typeof shoTurnLogSchema>;

const FOCUS_PARAM_TYPES: Readonly<Record<string, ShoRecordType>> = {
  customer: "customer",
  group: "group",
  order_number: "order",
  product: "product",
  price_list: "price_list",
  counterparty: "counterparty",
};

const SHOWN_BY_ACTION: Readonly<Record<string, ShoRecordType>> = {
  "customers.getCustomer": "customer",
  "catalog.getProduct": "product",
  "orders.get": "order",
};

const LISTED_BY_ACTION: Readonly<Record<string, ShoRecordType>> = {
  "customers.listCustomers": "customer",
  "customers.listGroups": "group",
  "catalog.listProducts": "product",
  "pricing.listPriceLists": "price_list",
  "orders.list": "order",
};

const ID_KEYS: Readonly<Record<ShoRecordType, string>> = {
  customer: "customerId",
  group: "groupId",
  order: "orderId",
  product: "productId",
  price_list: "priceListId",
  counterparty: "counterpartyId",
};

const NAME_KEYS: Readonly<Record<ShoRecordType, string>> = {
  customer: "name",
  group: "name",
  order: "orderNumber",
  product: "name",
  price_list: "name",
  counterparty: "name",
};

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

function viewOf(value: unknown, type: ShoRecordType): Seen | null {
  const id = text(value, ID_KEYS[type]) ?? text(value, "id");
  const name = text(value, NAME_KEYS[type]) ?? text(value, "name");
  return id === null ? null : { id, name: name ?? "" };
}

function rowsOf(value: unknown): readonly unknown[] {
  if (!isJson(value)) {
    return [];
  }
  const items = value["items"];
  return Array.isArray(items) ? items : [];
}

function refOf(param: ShoParam): ShoRef | null {
  if (Array.isArray(param) || !("status" in param) || "attrs" in param) {
    return null;
  }
  return "text" in param ? param : null;
}

function namedIn(command: ShoCommand): readonly ShoFocusRecord[] {
  const named: ShoFocusRecord[] = [];
  for (const [path, param] of Object.entries(command.params)) {
    const type = FOCUS_PARAM_TYPES[path];
    const ref = type === undefined ? null : refOf(param);
    if (type === undefined || ref === null || ref.status !== "resolved") {
      continue;
    }
    const id = ref.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    named.push({ type, id, name: ref.name ?? ref.text, how: "named" });
  }
  return named;
}

export function shoTurnRecords(
  command: ShoCommand,
  result: unknown,
): readonly ShoFocusRecord[] {
  const records: ShoFocusRecord[] = [];
  const creates = command.creates;
  if (creates !== undefined && creates.type !== SHO_UNRECOGNIZED) {
    const made = viewOf(result, creates.type);
    records.push({
      type: creates.type,
      id: made?.id ?? "",
      name: creates.name ?? made?.name ?? "",
      how: "created",
    });
  }
  const shown = SHOWN_BY_ACTION[command.action];
  const seen = shown === undefined ? null : viewOf(result, shown);
  if (shown !== undefined && seen !== null) {
    records.push({ type: shown, id: seen.id, name: seen.name, how: "shown" });
  }
  const listed = LISTED_BY_ACTION[command.action];
  if (listed !== undefined) {
    const rows = rowsOf(result);
    const only = rows.length === 1 ? viewOf(rows[0], listed) : null;
    records.push(
      only === null
        ? {
            type: listed,
            id: "",
            name: "",
            how: "listed",
            count: rows.length,
          }
        : { type: listed, id: only.id, name: only.name, how: "listed" },
    );
  }
  return [...records, ...namedIn(command)].slice(0, SHO_MOST_FOCUS);
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

interface Touched {
  readonly log: ShoTurnLog;
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
    if (parsed.success) {
      touched.push({ log: parsed.data, turns });
    }
  }
  return touched;
}

export function shoFocusFrom(
  history: readonly ModelMessage[],
  sessionId: string,
): readonly ShoFocusEntry[] {
  const held = new Set<string>();
  const focus: ShoFocusEntry[] = [];
  for (const { log, turns } of shoLogs(history)) {
    const earlier =
      log.sessionId === sessionId ? {} : { earlier: true as const };
    for (const record of log.records) {
      const key = `${record.type}\u0000${record.id}`;
      if (record.id.length > 0 && held.has(key)) {
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
  const { command, open, at } = newest.log;
  return !open && shoWrites(command) ? undefined : { command, at };
}
