/**
 * Staff customer list (SHO-175 / feature SHO-169). Mechanical choices for
 * *this* picker page. Copy pagination **helpers**, not this input bag,
 * when building a staff+AI list (ADR-0033).
 * - Pagination is a stable `(updated_at desc, id desc)` cursor, not
 *   offset. `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `updatedAt|id` (ISO datetime, then uuid).
 * - `status` defaults to `active`; `archived` and `all` are explicit.
 * - Search is optional, max 100. Name is token-AND of `nameSearchStems`
 *   as word-prefix `ilike` (SHO-396 / SHO-398); phone and email stay
 *   full-string contains. The row matches name-AND OR phone OR email.
 *   LIKE metacharacters `%`, `_`, and `\\` in the query are stripped so
 *   they cannot widen or escape the match; a query that strips to empty
 *   returns no rows.
 * - Optional `groupId`: own-tenant membership only. Missing and
 *   other-tenant group ids yield an empty page (no existence leak), not
 *   not-found.
 * - Output rows are the shared `CustomerView` (includes `status` and
 *   `linkedCounterpartyCount`). No order-count field.
 * - `timeout: 5000` matches the golden catalog/group reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). The ticket's `true` is
 *   that protocol, not the mutation idempotency suite.
 */
import { defineActionContract } from "@showzy/core/contract";
import { LIST_CUSTOMERS_SEARCH_MAX } from "@showzy/validation/customers";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import { customerViewSchema } from "./customer-view.contract.js";

export { LIST_CUSTOMERS_SEARCH_MAX };

export const LIST_CUSTOMERS_DEFAULT_LIMIT = 20;
export const LIST_CUSTOMERS_MAX_LIMIT = 50;
export const LIST_CUSTOMERS_CURSOR_MAX = 80;

const listCustomersCursor = createCursorCodec({
  payload: z.object({
    updatedAt: z.iso.datetime(),
    id: z.uuid(),
  }),
  fields: [
    { key: "updatedAt", kind: "isoDatetime" },
    { key: "id", kind: "uuid" },
  ],
});

export function formatListCustomersCursor(updatedAt: Date, id: string): string {
  return listCustomersCursor.encode({ updatedAt, id });
}

export function parseListCustomersCursor(
  cursor: string,
): { updatedAt: string; id: string } | undefined {
  return listCustomersCursor.decode(cursor);
}

export const listCustomersStatusFilterSchema = z.enum([
  "active",
  "archived",
  "all",
]);

export const listCustomersInputSchema = z.object({
  status: listCustomersStatusFilterSchema.default("active"),
  search: listSearchInput(LIST_CUSTOMERS_SEARCH_MAX),
  groupId: z.uuid().optional(),
  limit: listLimitInput(LIST_CUSTOMERS_MAX_LIMIT, LIST_CUSTOMERS_DEFAULT_LIMIT),
  cursor: listCursorInput(parseListCustomersCursor, LIST_CUSTOMERS_CURSOR_MAX),
});

export const listCustomersOutputSchema = z.object({
  items: z.array(customerViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listCustomersContract = defineActionContract({
  name: "customers.listCustomers",
  description:
    "List CRM customers in the staff member's active company. Default to active customers; pass status archived or all to include archived rows. Optional case-insensitive search: name matches every token stem (Ukrainian inflections); phone and email stay full-string contains. Optional group filter returns an empty page for a missing or foreign group. Paginate with an updated-at/id cursor and a page size of at most 50. Each row is the customer view (id, name, contacts, notes, group and price-list assignments, status, linked counterparty count, timestamps). Company id is never input. Does not return order counts.",
  principal: "staff",
  transport: "client",
  input: listCustomersInputSchema,
  output: listCustomersOutputSchema,
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
