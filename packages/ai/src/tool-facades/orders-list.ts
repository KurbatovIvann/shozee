/**
 * Named staff-assistant tools over `orders.list` (SHO-355 / SHO-356 /
 * SHO-360 / SHO-403 / ADR-0033).
 *
 * Presentation adapter only: both tools `execute("orders.list", canonical)`
 * then map compact output. Do not add `orders.listForAssistant`. Do not
 * flatten `list.contract.ts`. Global clip is a backstop after this map.
 */
import type { ActionContract } from "@showzy/core/contract";
import {
  LIST_ORDERS_CURSOR_MAX,
  LIST_ORDERS_CUSTOMER_IDS_MAX,
  LIST_ORDERS_QUERY_MAX,
  LIST_ORDERS_SUMMARY_DEFAULT_LIMIT,
  LIST_ORDERS_SUMMARY_MAX_LIMIT,
} from "@showzy/orders/contract";
import {
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_LIST_PROMPT_LINE,
} from "@showzy/validation/assistant-surfaces";
import { CUSTOMER_NAME_MAX } from "@showzy/validation/customers";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";
import { STAFF_ASSISTANT_CLIP_JSON_MAX } from "../clip-tool-result.js";
import { isStaffAssistantConfirmationOutput } from "../confirmation.js";
import {
  mapOrdersListPeriod,
  ORDERS_LIST_PERIODS,
  type OrdersListPeriod,
} from "../kyiv-calendar.js";

export const ORDERS_LIST_ACTION_NAME = "orders.list";
export const ORDERS_LIST_PAGE_TOOL_NAME = "orders_list_page";
export const ORDERS_LIST_COUNTS_TOOL_NAME = "orders_list_counts";

export {
  CUSTOMER_NAME_MAX,
  LIST_ORDERS_CURSOR_MAX,
  LIST_ORDERS_CUSTOMER_IDS_MAX,
  LIST_ORDERS_QUERY_MAX,
};

/**
 * Named assistant `limit` (SHO-403). Same numbers as
 * `LIST_ORDERS_SUMMARY_DEFAULT_LIMIT` / `LIST_ORDERS_SUMMARY_MAX_LIMIT`.
 * Do not keep the clip-era fixed page of 9.
 */
export const ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT =
  LIST_ORDERS_SUMMARY_DEFAULT_LIMIT;
export const ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT =
  LIST_ORDERS_SUMMARY_MAX_LIMIT;

const orderStatusSchema = z.enum([
  "new",
  "confirmed",
  "in_progress",
  "done",
  "canceled",
]);
const periodField = z.enum(ORDERS_LIST_PERIODS).optional();

const statusesField = z.array(orderStatusSchema).min(1).max(5).optional();
const queryField = z
  .string()
  .trim()
  .min(1)
  .max(LIST_ORDERS_QUERY_MAX)
  .optional();
const cursorField = z.string().min(1).max(LIST_ORDERS_CURSOR_MAX).optional();
const createdFromField = z.iso.datetime().optional();
const createdToField = z.iso.datetime().optional();
const customerIdsField = z
  .array(z.uuid())
  .min(1)
  .max(LIST_ORDERS_CUSTOMER_IDS_MAX)
  .optional();

function createdIntervalIsValid(input: {
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
}): boolean {
  return (
    input.createdFrom === undefined ||
    input.createdTo === undefined ||
    input.createdFrom <= input.createdTo
  );
}

function periodXorDatesIsValid(input: {
  period?: OrdersListPeriod | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
}): boolean {
  const hasPeriod = input.period !== undefined;
  const hasDates =
    input.createdFrom !== undefined || input.createdTo !== undefined;
  return !(hasPeriod && hasDates);
}

const createdIntervalRefine = {
  message: "createdFrom must be less than or equal to createdTo",
} as const;

const periodXorDatesRefine = {
  message: "period cannot be combined with createdFrom or createdTo",
} as const;

const limitField = z
  .number()
  .int()
  .min(1)
  .max(ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT)
  .default(ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT);

export const ordersListPageInputSchema = z
  .strictObject({
    statuses: statusesField,
    query: queryField,
    cursor: cursorField,
    createdFrom: createdFromField,
    createdTo: createdToField,
    customerIds: customerIdsField,
    period: periodField,
    limit: limitField,
  })
  .refine(createdIntervalIsValid, createdIntervalRefine)
  .refine(periodXorDatesIsValid, periodXorDatesRefine);

export const ordersListCountsInputSchema = z
  .strictObject({
    statuses: statusesField,
    query: queryField,
    groupBy: z
      .enum(["none", "status", "product", "customer"])
      .default("status"),
    createdFrom: createdFromField,
    createdTo: createdToField,
    customerIds: customerIdsField,
    period: periodField,
  })
  .refine(createdIntervalIsValid, createdIntervalRefine)
  .refine(periodXorDatesIsValid, periodXorDatesRefine);

export type OrdersListPageFacadeInput = z.output<
  typeof ordersListPageInputSchema
>;
export type OrdersListPageFacadeMapInput = z.input<
  typeof ordersListPageInputSchema
>;
export type OrdersListCountsFacadeInput = z.output<
  typeof ordersListCountsInputSchema
>;

const ORDERS_LIST_PAGE_DESCRIPTION = `Newest-first order headers in the active company. Compact rows: orderId, orderNumber, customer (nameSnapshot, linkedCustomerId), status, itemCount, totalGrossMinor, currency, createdAt. Optional statuses (new, confirmed, in_progress, done, canceled; max 5). Omit statuses to include every CHECK status. There is no server status named active or all. UI Активні is client grouping of new plus confirmed plus in_progress — do not pass active, all, or completed. Optional query matches the text order number (optional leading #) or CRM name, phone, or email and requires customers:view. Put people and product names in nominative (Катя Самбука, Наполеон) — not the inflected form from the staff sentence (Каті Самбуки, наполеона). Pass only the name or query, not the whole utterance («замовлення для …»). One empty page is not "does not exist": retry with nominative and/or the last-name or product-name stem before telling the staff member nobody or nothing matches. Optional customerIds (1–50 UUIDs). Prefer period=today, period=this_week, or period=this_month (Europe/Kyiv, week starts Monday, inclusive local day) for those ranges. ISO createdFrom/createdTo remains valid for other intervals. Do not pass period together with createdFrom/createdTo. Do not pass yesterday/thisWeek enums. Optional limit 1–${String(ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT)} (default ${String(ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT)}) — pass limit for “last N orders”; do not fetch a larger page and slice in the model. Optional cursor pages forward. Completed output includes requestedLimit, rows, and hasMore (nextCursor != null) so every visible row matches the handler cursor. Does not return line items. For “how many orders” / “turnover” / “gross” in a period, use orders_list_counts (do not page this tool and sum in the model). ${ORDERS_LIST_PROMPT_LINE}`;

const ORDERS_LIST_COUNTS_DESCRIPTION = `Bounded order rollup in the active company. This is the tool for “how many orders” / “turnover” / “gross” in a period. Do not page orders_list_page and sum in the model. Do not refuse those jobs as analytics and do not send the staff member to the Analytics / Reports tabs for that question. Optional statuses (new, confirmed, in_progress, done, canceled; max 5). Omit statuses to include every CHECK status. There is no server status named active or all. UI Активні is client grouping of new plus confirmed plus in_progress — do not pass active, all, or completed. Optional query matches the text order number (optional leading #) or CRM name, phone, or email and requires customers:view. Put people and product names in nominative (Катя Самбука, Наполеон) — not the inflected form from the staff sentence (Каті Самбуки, наполеона). Pass only the name or query, not the whole utterance («замовлення для …»). One empty page is not "does not exist": retry with nominative and/or the last-name or product-name stem before telling the staff member nobody or nothing matches. Optional customerIds (1–50 UUIDs). Prefer period=today, period=this_week, or period=this_month (Europe/Kyiv, week starts Monday, inclusive local day) for those ranges. ISO createdFrom/createdTo remains valid for other intervals. Do not pass period together with createdFrom/createdTo. Do not pass yesterday/thisWeek enums. groupBy defaults to status (none, status, product, or customer). Do not use groupBy none just to get a company total — orderCount, grossByCurrency, and statusBuckets are always present. Product buckets include quantityMilli (sum of line quantity_milli for that SKU, across currencies). Money buckets never mix currencies. Output always keeps orderCount, every grossByCurrency.grossAmountMinor, and statusBuckets (count and money per CHECK status that occurred, max 5). ${ORDERS_AGGREGATE_PROMPT_LINE}`;

type OrdersListMappedFilter = {
  readonly statuses?: NonNullable<OrdersListPageFacadeInput["statuses"]>;
  readonly query?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly customerIds?: NonNullable<OrdersListPageFacadeInput["customerIds"]>;
};

export type OrdersListMapClock = {
  readonly now: Date;
};

function mappedOrdersListFilter(
  input: {
    readonly statuses?: OrdersListPageFacadeInput["statuses"];
    readonly query?: string | undefined;
    readonly createdFrom?: string | undefined;
    readonly createdTo?: string | undefined;
    readonly customerIds?: OrdersListPageFacadeInput["customerIds"];
    readonly period?: OrdersListPeriod | undefined;
  },
  clock: OrdersListMapClock,
): OrdersListMappedFilter | undefined {
  let createdFrom = input.createdFrom;
  let createdTo = input.createdTo;
  if (input.period !== undefined) {
    const interval = mapOrdersListPeriod(input.period, clock.now);
    createdFrom = interval.createdFrom;
    createdTo = interval.createdTo;
  }
  const filter: {
    statuses?: NonNullable<OrdersListPageFacadeInput["statuses"]>;
    query?: string;
    createdFrom?: string;
    createdTo?: string;
    customerIds?: NonNullable<OrdersListPageFacadeInput["customerIds"]>;
  } = {
    ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(createdFrom !== undefined ? { createdFrom } : {}),
    ...(createdTo !== undefined ? { createdTo } : {}),
    ...(input.customerIds !== undefined
      ? { customerIds: input.customerIds }
      : {}),
  };
  if (Object.keys(filter).length === 0) {
    return undefined;
  }
  return filter;
}

export function mapOrdersListPageInput(
  input: OrdersListPageFacadeMapInput,
  clock: OrdersListMapClock = { now: new Date() },
): {
  readonly kind: "page.summary";
  readonly filter?: OrdersListMappedFilter;
  readonly limit: number;
  readonly cursor?: string;
} {
  const filter = mappedOrdersListFilter(input, clock);
  return {
    kind: "page.summary",
    ...(filter !== undefined ? { filter } : {}),
    limit: input.limit ?? ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

export function mapOrdersListCountsInput(
  input: OrdersListCountsFacadeInput,
  clock: OrdersListMapClock = { now: new Date() },
): {
  readonly kind: "aggregate";
  readonly filter?: OrdersListMappedFilter;
  readonly groupBy: OrdersListCountsFacadeInput["groupBy"];
} {
  const filter = mappedOrdersListFilter(input, clock);
  return {
    kind: "aggregate",
    ...(filter !== undefined ? { filter } : {}),
    groupBy: input.groupBy,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isTypedToolError(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["status"] === "error" &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  );
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return STAFF_ASSISTANT_CLIP_JSON_MAX + 1;
  }
}

function compactNameSnapshot(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= CUSTOMER_NAME_MAX) {
    return value;
  }
  return value.slice(0, CUSTOMER_NAME_MAX);
}

function compactCustomer(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    nameSnapshot: compactNameSnapshot(value["nameSnapshot"]),
    linkedCustomerId: value["linkedCustomerId"],
  };
}

function mapOrdersListPageCompactRow(row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  return {
    orderId: row["orderId"],
    orderNumber: row["orderNumber"],
    customer: compactCustomer(row["customer"]),
    status: row["status"],
    itemCount: row["itemCount"],
    totalGrossMinor: row["totalGrossMinor"],
    currency: row["currency"],
    createdAt: row["createdAt"],
  };
}

/**
 * Assistant completed view of `orders.list` `page.summary`. Compact
 * `rows` plus `requestedLimit` and `hasMore` (`nextCursor != null`).
 * Typed errors and confirmation payloads pass through unchanged.
 */
export function mapOrdersListPageOutput(
  output: unknown,
  requestedLimit: number = ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT,
): unknown {
  if (
    isStaffAssistantConfirmationOutput(output) ||
    isTypedToolError(output) ||
    !isRecord(output) ||
    output["kind"] !== "page.summary" ||
    !isUnknownArray(output["items"])
  ) {
    return output;
  }
  const nextCursor = output["nextCursor"];
  const cursor = nextCursor === undefined ? null : nextCursor;
  return {
    kind: "page.summary",
    requestedLimit,
    rows: output["items"].map((row) => mapOrdersListPageCompactRow(row)),
    hasMore: cursor !== null,
    nextCursor: cursor,
    customerMatchTruncated: output["customerMatchTruncated"],
  };
}

function compactGrossByCurrency(value: unknown): unknown {
  if (!isUnknownArray(value)) {
    return value;
  }
  return value.map((row) => {
    if (!isRecord(row)) {
      return row;
    }
    return {
      currency: row["currency"],
      grossAmountMinor: row["grossAmountMinor"],
    };
  });
}

function compactBucketIdentity(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (value["kind"] === "product") {
    return {
      kind: "product",
      productId: value["productId"],
      variantId: value["variantId"],
    };
  }
  if (value["kind"] === "customer") {
    return {
      kind: "customer",
      customerId: value["customerId"],
      nameSnapshot: value["nameSnapshot"],
    };
  }
  if (value["kind"] === "status") {
    return { kind: "status", status: value["status"] };
  }
  if (value["kind"] === "none") {
    return { kind: "none" };
  }
  return value;
}

function mapOrdersListCompactBucket(row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  const identity = compactBucketIdentity(row["identity"]);
  const bucket: {
    identity: unknown;
    label: unknown;
    orderCount: unknown;
    grossByCurrency: unknown;
    quantityMilli?: unknown;
  } = {
    identity,
    label: row["label"],
    orderCount: row["orderCount"],
    grossByCurrency: compactGrossByCurrency(row["grossByCurrency"]),
  };
  if (isRecord(identity) && identity["kind"] === "product") {
    bucket.quantityMilli = row["quantityMilli"];
  }
  return bucket;
}

function countsPayload(
  base: Record<string, unknown>,
  buckets: unknown[],
  bucketsOmitted?: number,
): Record<string, unknown> {
  return {
    ...base,
    buckets,
    ...(bucketsOmitted !== undefined ? { bucketsOmitted } : {}),
  };
}

/**
 * Assistant view of `orders.list` aggregate. Always keeps `orderCount`,
 * every `grossByCurrency[].grossAmountMinor`, and `statusBuckets`.
 * Slices groupBy `buckets` to a prefix that fits the clip cap and sets
 * adapter `bucketsOmitted`.
 */
export function mapOrdersListCountsOutput(output: unknown): unknown {
  if (
    isStaffAssistantConfirmationOutput(output) ||
    isTypedToolError(output) ||
    !isRecord(output) ||
    output["kind"] !== "aggregate" ||
    !isUnknownArray(output["buckets"])
  ) {
    return output;
  }
  const compactBuckets = output["buckets"].map((row) =>
    mapOrdersListCompactBucket(row),
  );
  const rawStatusBuckets = output["statusBuckets"];
  const compactStatusBuckets = isUnknownArray(rawStatusBuckets)
    ? rawStatusBuckets.map((row) => mapOrdersListCompactBucket(row))
    : [];
  const base: Record<string, unknown> = {
    kind: "aggregate",
    orderCount: output["orderCount"],
    grossByCurrency: compactGrossByCurrency(output["grossByCurrency"]),
    statusBuckets: compactStatusBuckets,
    bucketsTruncated: output["bucketsTruncated"],
    customerMatchTruncated: output["customerMatchTruncated"],
  };
  const full = countsPayload(base, compactBuckets);
  if (jsonLength(full) <= STAFF_ASSISTANT_CLIP_JSON_MAX) {
    return full;
  }
  let best = 0;
  let low = 0;
  let high = compactBuckets.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const omitted = compactBuckets.length - mid;
    const candidate = countsPayload(
      base,
      compactBuckets.slice(0, mid),
      omitted,
    );
    if (jsonLength(candidate) <= STAFF_ASSISTANT_CLIP_JSON_MAX) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return countsPayload(
    base,
    compactBuckets.slice(0, best),
    compactBuckets.length - best,
  );
}

/**
 * Two hot ToolSet entries that still execute the `orders.list` registry
 * name (audit, permissions, timeout unchanged).
 */
export function ordersListFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [ORDERS_LIST_PAGE_TOOL_NAME]: tool({
      description: ORDERS_LIST_PAGE_DESCRIPTION,
      inputSchema: ordersListPageInputSchema,
      execute: async (input, options) => {
        const parsed = ordersListPageInputSchema.parse(input);
        const canonical = mapOrdersListPageInput(parsed);
        const raw = await execute(
          ORDERS_LIST_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
        return mapOrdersListPageOutput(raw, parsed.limit);
      },
    }),
    [ORDERS_LIST_COUNTS_TOOL_NAME]: tool({
      description: ORDERS_LIST_COUNTS_DESCRIPTION,
      inputSchema: ordersListCountsInputSchema,
      execute: async (input, options) => {
        const parsed = ordersListCountsInputSchema.parse(input);
        const canonical = mapOrdersListCountsInput(parsed);
        const raw = await execute(
          ORDERS_LIST_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
        return mapOrdersListCountsOutput(raw);
      },
    }),
  };
}
