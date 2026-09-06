/**
 * Staff order list as a channel-neutral domain query (SHO-351 / ADR-0033).
 * Copy this `kind` + extensible `filter` shape for later staff+AI lists.
 * Copy pagination **helpers** from `@showzy/validation/pagination`.
 *
 * - `kind` selects the job: a summary page, a page with compact lines, or
 *   a server aggregate. There is no server status `active` or `all`; omit
 *   `filter.statuses` for every CHECK status (`new`, `confirmed`,
 *   `in_progress`, `done`, `canceled`). UI Активні = `new` + `confirmed` +
 *   `in_progress` is client grouping only — never a server filter value.
 * - `query` matches the text order number (optional leading `#`) OR live
 *   CRM name/phone/email via internal `customers.listMatchingIds`. Any
 *   query requires `customers:view`. Max 100 after trim.
 * - Caps: summary page default 20 max 50; withLines max 20 orders and
 *   200 lines; aggregate buckets max 50; statusBuckets max 5 CHECK
 *   statuses; `customerIds` max 50.
 * - Unlinked snapshot sentinel is `unlinked` (presenters localize).
 * - `timeout: 10000` covers nested `customers.listMatchingIds` (5000)
 *   plus the orders query (mechanical; was 10000 for paged CRM drain).
 * - Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import { moneyWireSchema, quantityMilliWireSchema } from "../wire.contract.js";
import { orderStatusSchema } from "./order-view.contract.js";

export const UNLINKED_CUSTOMER_NAME_SNAPSHOT = "unlinked";

export const LIST_ORDERS_SUMMARY_DEFAULT_LIMIT = 20;
export const LIST_ORDERS_SUMMARY_MAX_LIMIT = 50;
export const LIST_ORDERS_WITH_LINES_MAX_LIMIT = 20;
export const LIST_ORDERS_WITH_LINES_MAX_LINES = 200;
export const LIST_ORDERS_AGGREGATE_BUCKETS_MAX = 50;
export const LIST_ORDERS_STATUS_BUCKETS_MAX = 5;
export const LIST_ORDERS_CUSTOMER_IDS_MAX = 50;
export const LIST_ORDERS_CURSOR_MAX = 80;
export const LIST_ORDERS_QUERY_MAX = 100;

const listOrdersCursor = createCursorCodec({
  payload: z.object({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "createdAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListOrdersCursor(createdAt: Date, id: string): string {
  return listOrdersCursor.encode({ createdAt, id });
}

export function parseListOrdersCursor(
  cursor: string,
): { createdAt: string; id: string } | undefined {
  return listOrdersCursor.decode(cursor);
}

export const listOrdersFilterSchema = z
  .object({
    statuses: z.array(orderStatusSchema).min(1).max(5).optional(),
    query: listSearchInput(LIST_ORDERS_QUERY_MAX),
    customerIds: z
      .array(z.uuid())
      .min(1)
      .max(LIST_ORDERS_CUSTOMER_IDS_MAX)
      .optional(),
    createdFrom: z.iso.datetime().optional(),
    createdTo: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (filter) =>
      filter.createdFrom === undefined ||
      filter.createdTo === undefined ||
      filter.createdFrom <= filter.createdTo,
    { message: "createdFrom must be less than or equal to createdTo" },
  );

const listOrdersCursorField = listCursorInput(
  parseListOrdersCursor,
  LIST_ORDERS_CURSOR_MAX,
);

export const listOrdersPageSummaryInputSchema = z.strictObject({
  kind: z.literal("page.summary"),
  filter: listOrdersFilterSchema.optional(),
  limit: listLimitInput(
    LIST_ORDERS_SUMMARY_MAX_LIMIT,
    LIST_ORDERS_SUMMARY_DEFAULT_LIMIT,
  ),
  cursor: listOrdersCursorField,
});

export const listOrdersPageWithLinesInputSchema = z.strictObject({
  kind: z.literal("page.withLines"),
  filter: listOrdersFilterSchema.optional(),
  limit: listLimitInput(
    LIST_ORDERS_WITH_LINES_MAX_LIMIT,
    LIST_ORDERS_WITH_LINES_MAX_LIMIT,
  ),
  cursor: listOrdersCursorField,
});

export const listOrdersAggregateGroupBySchema = z.enum([
  "none",
  "status",
  "product",
  "customer",
]);

export const listOrdersAggregateInputSchema = z.strictObject({
  kind: z.literal("aggregate"),
  filter: listOrdersFilterSchema.optional(),
  groupBy: listOrdersAggregateGroupBySchema.default("none"),
});

export const listOrdersInputSchema = z.discriminatedUnion("kind", [
  listOrdersPageSummaryInputSchema,
  listOrdersPageWithLinesInputSchema,
  listOrdersAggregateInputSchema,
]);

export const listOrderCustomerSchema = z.object({
  nameSnapshot: z.string().min(1),
  linkedCustomerId: z.uuid().nullable(),
});

export const listOrderSummaryRowSchema = z.object({
  orderId: z.uuid(),
  orderNumber: z.string().min(1),
  customer: listOrderCustomerSchema,
  status: orderStatusSchema,
  itemCount: z.number().int().nonnegative(),
  totalGrossMinor: moneyWireSchema,
  currency: z.string().length(3),
  createdAt: z.iso.datetime(),
});

export const listOrderCompactLineSchema = z.object({
  itemId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  titleSnapshot: z.string().min(1),
  quantityMilli: quantityMilliWireSchema,
  grossAmountMinor: moneyWireSchema,
  currency: z.string().length(3),
});

export const listOrderWithLinesRowSchema = listOrderSummaryRowSchema.extend({
  lines: z.array(listOrderCompactLineSchema),
});

export const listOrdersGrossByCurrencySchema = z.object({
  currency: z.string().length(3),
  grossAmountMinor: moneyWireSchema,
});

export const listOrdersBucketIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product"),
    productId: z.uuid(),
    variantId: z.uuid().nullable(),
  }),
  z.object({
    kind: z.literal("customer"),
    customerId: z.uuid().nullable(),
    nameSnapshot: z.string().min(1),
  }),
  z.object({
    kind: z.literal("status"),
    status: orderStatusSchema,
  }),
  z.object({
    kind: z.literal("none"),
  }),
]);

const listOrdersBucketSharedFields = {
  label: z.string(),
  orderCount: z.number().int().nonnegative(),
  grossByCurrency: z.array(listOrdersGrossByCurrencySchema),
};

/** Product buckets carry line-quantity milli; other groupBy kinds do not. */
export const listOrdersProductBucketSchema = z.object({
  identity: z.object({
    kind: z.literal("product"),
    productId: z.uuid(),
    variantId: z.uuid().nullable(),
  }),
  ...listOrdersBucketSharedFields,
  quantityMilli: quantityMilliWireSchema,
});

export const listOrdersOtherBucketSchema = z.object({
  identity: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("customer"),
      customerId: z.uuid().nullable(),
      nameSnapshot: z.string().min(1),
    }),
    z.object({
      kind: z.literal("status"),
      status: orderStatusSchema,
    }),
    z.object({
      kind: z.literal("none"),
    }),
  ]),
  ...listOrdersBucketSharedFields,
});

export const listOrdersBucketSchema = z.union([
  listOrdersProductBucketSchema,
  listOrdersOtherBucketSchema,
]);

/** Always-on CHECK-status rollup for `kind: "aggregate"` (SHO-395). */
export const listOrdersStatusBucketSchema = z.object({
  identity: z.object({
    kind: z.literal("status"),
    status: orderStatusSchema,
  }),
  ...listOrdersBucketSharedFields,
});

export const listOrdersPageSummaryOutputSchema = z.strictObject({
  kind: z.literal("page.summary"),
  items: z.array(listOrderSummaryRowSchema),
  nextCursor: z.string().min(1).nullable(),
  customerMatchTruncated: z.boolean(),
});

export const listOrdersPageWithLinesOutputSchema = z.strictObject({
  kind: z.literal("page.withLines"),
  items: z.array(listOrderWithLinesRowSchema),
  nextCursor: z.string().min(1).nullable(),
  customerMatchTruncated: z.boolean(),
  linesTruncated: z.boolean(),
});

export const listOrdersAggregateOutputSchema = z.strictObject({
  kind: z.literal("aggregate"),
  orderCount: z.number().int().nonnegative(),
  grossByCurrency: z.array(listOrdersGrossByCurrencySchema),
  buckets: z.array(listOrdersBucketSchema),
  bucketsTruncated: z.boolean(),
  customerMatchTruncated: z.boolean(),
  statusBuckets: z
    .array(listOrdersStatusBucketSchema)
    .max(LIST_ORDERS_STATUS_BUCKETS_MAX),
});

export const listOrdersOutputSchema = z.discriminatedUnion("kind", [
  listOrdersPageSummaryOutputSchema,
  listOrdersPageWithLinesOutputSchema,
  listOrdersAggregateOutputSchema,
]);

export type ListOrdersInput = z.output<typeof listOrdersInputSchema>;
export type ListOrdersFilter = NonNullable<ListOrdersInput["filter"]>;
export type ListOrderSummaryRow = z.output<typeof listOrderSummaryRowSchema>;
export type ListOrderCompactLine = z.output<typeof listOrderCompactLineSchema>;
export type ListOrdersGrossByCurrency = z.output<
  typeof listOrdersGrossByCurrencySchema
>;
export type ListOrdersProductBucket = z.output<
  typeof listOrdersProductBucketSchema
>;
export type ListOrdersBucket = z.output<typeof listOrdersBucketSchema>;
export type ListOrdersStatusBucket = z.output<
  typeof listOrdersStatusBucketSchema
>;
export type ListOrdersOutput = z.output<typeof listOrdersOutputSchema>;

export const listOrdersContract = defineActionContract({
  name: "orders.list",
  description:
    "Query staff-intake orders in the staff member's active company. Pass kind page.summary or page.withLines for a newest-first cursor page, or kind aggregate for a bounded server rollup. Omit filter.statuses to include every CHECK status (new, confirmed, in_progress, done, canceled); there is no server status named active or all. UI Активні is client grouping of new plus confirmed plus in_progress — do not send active as a filter value. Optional filter.query matches the text order number (optional leading #) or CRM customer name, phone, or email and always requires customers:view. Optional customerIds, createdFrom, and createdTo compose with query. Summary rows include the customer name snapshot and linkedCustomerId, itemCount, and header totals — not the get view. Aggregate output always includes orderCount, currency-safe grossByCurrency, and statusBuckets (bounded GROUP BY CHECK status, max 5). The groupBy buckets stay: product (productId+variantId), customer, status, or none. groupBy none still returns one total bucket and statusBuckets. Product buckets include quantityMilli (sum of line quantity_milli for that SKU, across currencies). Company id is never input. Does not filter by payment.",
  principal: "staff",
  transport: "client",
  input: listOrdersInputSchema,
  output: listOrdersOutputSchema,
  permissions: ["orders:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 10_000,
});
