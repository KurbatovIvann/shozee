/**
 * Staff catalog list (SHO-135 / catalog-T7). Mechanical choices for *this*
 * picker page: cursor pagination helpers, LIKE sanitization, default
 * `limit` 20 / cap 50. Copy those **helpers**, not this input bag, when
 * building a staff+AI list (ADR-0033 / SHO-350 `orders.list`).
 * - Pagination is a stable `(createdAt desc, id desc)` cursor, not offset.
 *   `limit` defaults to 20 and caps at 50 (small-business catalog pages).
 * - `status` defaults to `active`; `archived` and `all` are explicit.
 * - Name search is optional. Name is token-AND of `nameSearchStems` as
 *   word-prefix `ilike` (SHO-396 / SHO-400). LIKE metacharacters `%`,
 *   `_`, and `\\` in the query are stripped so they cannot widen or
 *   escape the match; a query that strips to empty returns no rows.
 * - Primary image is lowest `position`, then media id (same as
 *   `getProduct.imageFileIds[0]`).
 * - `timeout: 5000` matches the golden catalog reads.
 * - Money wire is `@showzy/validation/money` via `wire.contract.ts`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { LIST_PRODUCTS_QUERY_MAX } from "@showzy/validation/catalog";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import { moneyWireSchema, productStatusSchema } from "../wire.contract.js";

export { LIST_PRODUCTS_QUERY_MAX };

export const LIST_PRODUCTS_DEFAULT_LIMIT = 20;
export const LIST_PRODUCTS_MAX_LIMIT = 50;
export const LIST_PRODUCTS_CURSOR_MAX = 80;

const listProductsCursor = createCursorCodec({
  payload: z.object({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "createdAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListProductsCursor(createdAt: Date, id: string): string {
  return listProductsCursor.encode({ createdAt, id });
}

export function parseListProductsCursor(
  cursor: string,
): { createdAt: string; id: string } | undefined {
  return listProductsCursor.decode(cursor);
}

export const listProductsStatusFilterSchema = z.enum([
  "active",
  "archived",
  "all",
]);

export const listProductsInputSchema = z.object({
  status: listProductsStatusFilterSchema.default("active"),
  query: listSearchInput(LIST_PRODUCTS_QUERY_MAX),
  limit: listLimitInput(LIST_PRODUCTS_MAX_LIMIT, LIST_PRODUCTS_DEFAULT_LIMIT),
  cursor: listCursorInput(parseListProductsCursor, LIST_PRODUCTS_CURSOR_MAX),
});

export const listProductRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  basePriceMinor: moneyWireSchema,
  currency: z.string().length(3),
  status: productStatusSchema,
  variantCount: z.number().int().nonnegative(),
  primaryImageFileId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const listProductsOutputSchema = z.object({
  items: z.array(listProductRowSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listProductsContract = defineActionContract({
  name: "catalog.listProducts",
  description:
    "List products in the staff member's active company. Default to active products; pass status archived or all to include archived rows. Optional case-insensitive name search: every token stem must match as a word prefix (Ukrainian inflections). Paginate with a created-at cursor and a page size of at most 50. Each row includes id, name, base price, currency, status, variant count, the primary image fileId (lowest position, if any), and timestamps. Clients fetch display URLs via files.getDownloadUrl — this action never returns URLs or object keys.",
  principal: "staff",
  transport: "client",
  input: listProductsInputSchema,
  output: listProductsOutputSchema,
  permissions: ["products:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
});
