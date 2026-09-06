/**
 * Staff counterparty list (SHO-194 / feature SHO-191). Mechanical choices
 * the feature card left unnamed — copy `customers.listCustomers`, do not
 * invent a second list shape or a second projection:
 * - Pagination is a stable `(updated_at desc, id desc)` cursor, not
 *   offset. `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `updatedAt|id` (ISO datetime, then uuid).
 * - Search is optional, max 100, case-insensitive Drizzle `ilike` on
 *   name OR edrpou (not IBAN). LIKE metacharacters `%`, `_`, and `\\` in
 *   the query are stripped so they cannot widen or escape the match; a
 *   query that strips to empty returns no rows.
 * - Optional `customerId`: own-tenant links only. Missing and
 *   other-tenant customer ids yield an empty page (no existence leak),
 *   not not-found.
 * - No status/archive filter. No group/price-list filter.
 * - Output rows are the shared `CounterpartyView`.
 * - `timeout: 5000` matches the golden CRM reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). Do not invent mutation
 *   idempotency on reads.
 */
import { defineActionContract } from "@showzy/core/contract";
import { LIST_COUNTERPARTIES_SEARCH_MAX } from "@showzy/validation/customers";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import { counterpartyViewSchema } from "./counterparty-view.contract.js";

export { LIST_COUNTERPARTIES_SEARCH_MAX };

export const LIST_COUNTERPARTIES_DEFAULT_LIMIT = 20;
export const LIST_COUNTERPARTIES_MAX_LIMIT = 50;
export const LIST_COUNTERPARTIES_CURSOR_MAX = 80;

const listCounterpartiesCursor = createCursorCodec({
  payload: z.object({
    updatedAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "updatedAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListCounterpartiesCursor(
  updatedAt: Date,
  id: string,
): string {
  return listCounterpartiesCursor.encode({ updatedAt, id });
}

export function parseListCounterpartiesCursor(
  cursor: string,
): { updatedAt: string; id: string } | undefined {
  return listCounterpartiesCursor.decode(cursor);
}

export const listCounterpartiesInputSchema = z.object({
  search: listSearchInput(LIST_COUNTERPARTIES_SEARCH_MAX),
  customerId: z.uuid().optional(),
  limit: listLimitInput(
    LIST_COUNTERPARTIES_MAX_LIMIT,
    LIST_COUNTERPARTIES_DEFAULT_LIMIT,
  ),
  cursor: listCursorInput(
    parseListCounterpartiesCursor,
    LIST_COUNTERPARTIES_CURSOR_MAX,
  ),
});

export const listCounterpartiesOutputSchema = z.object({
  items: z.array(counterpartyViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listCounterpartiesContract = defineActionContract({
  name: "customers.listCounterparties",
  description:
    "List company counterparties (legal faces for documents) in the staff member's active company. Optional case-insensitive search on legal name or EDRPOU. Optional customer filter returns an empty page for a missing or foreign customer. Paginate with an updated-at/id cursor and a page size of at most 50. Each row is the shared counterparty view (id, legal name, requisites, optional linked CRM customer id and live customer name, timestamps). Company id is never input. Counterparties are not archived.",
  principal: "staff",
  transport: "client",
  input: listCounterpartiesInputSchema,
  output: listCounterpartiesOutputSchema,
  permissions: ["customers:view"],
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
