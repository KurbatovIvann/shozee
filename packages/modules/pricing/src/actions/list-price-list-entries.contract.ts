/**
 * Staff price-list entry list (SHO-185 / pricing-T7). Mechanical choices
 * copied from `catalog.listProducts` and `pricing.listPriceLists`:
 * - Pagination is a stable `(createdAt desc, id desc)` cursor, not offset.
 *   `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `createdAtISO|id` (same shape as listProducts).
 * - Optional `productId` filters to that product's product- and
 *   variant-level rows on the named list.
 * - Missing and foreign-company lists fail with the same not-found.
 * - Company id is never input.
 * - `timeout: 5000` matches the golden pricing/catalog reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md treats reads as
 *   naturally idempotent (no key, no storage).
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import {
  currencyCodeSchema,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";

export const LIST_PRICE_LIST_ENTRIES_DEFAULT_LIMIT = 20;
export const LIST_PRICE_LIST_ENTRIES_MAX_LIMIT = 50;
export const LIST_PRICE_LIST_ENTRIES_CURSOR_MAX = 80;

const listPriceListEntriesCursor = createCursorCodec({
  payload: z.object({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "createdAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListPriceListEntriesCursor(
  createdAt: Date,
  id: string,
): string {
  return listPriceListEntriesCursor.encode({ createdAt, id });
}

export function parseListPriceListEntriesCursor(
  cursor: string,
): { createdAt: string; id: string } | undefined {
  return listPriceListEntriesCursor.decode(cursor);
}

export const listPriceListEntriesInputSchema = z.object({
  priceListId: z.uuid(),
  productId: z.uuid().optional(),
  limit: listLimitInput(
    LIST_PRICE_LIST_ENTRIES_MAX_LIMIT,
    LIST_PRICE_LIST_ENTRIES_DEFAULT_LIMIT,
  ),
  cursor: listCursorInput(
    parseListPriceListEntriesCursor,
    LIST_PRICE_LIST_ENTRIES_CURSOR_MAX,
  ),
});

export const priceListEntryRowSchema = z.object({
  id: z.uuid(),
  priceListId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  priceMinor: nonNegativeMoneyWireSchema,
  currency: currencyCodeSchema,
});

export const listPriceListEntriesOutputSchema = z.object({
  items: z.array(priceListEntryRowSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listPriceListEntriesContract = defineActionContract({
  name: "pricing.listPriceListEntries",
  description:
    "List price-list entries for a price list in the staff member's active company. Optional productId limits the page to that product's product-level and variant-level rows. Paginate with a created-at cursor and a page size of at most 50. Each row includes id, priceListId, productId, variantId (null for product-level), price in minor units, and currency. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: listPriceListEntriesInputSchema,
  output: listPriceListEntriesOutputSchema,
  permissions: ["pricing:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
