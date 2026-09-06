/**
 * Staff group list (SHO-177 / feature SHO-169). Mechanical choices for
 * *this* picker page. Copy pagination **helpers**, not this input bag,
 * when building a staff+AI list (ADR-0033).
 * - Pagination is a stable `(sort_order asc, name asc, id asc)` cursor,
 *   not offset. `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `sortOrder|id|name` so the name (which may contain
 *   `|`) is the remainder after the second separator.
 * - Name search is optional, case-insensitive Drizzle `ilike`, max 100.
 *   LIKE metacharacters `%`, `_`, and `\\` in the query are stripped so
 *   they cannot widen or escape the match; a query that strips to empty
 *   returns no rows. No color filter. No archived filter (groups are
 *   not archived).
 * - `timeout: 5000` matches the golden catalog/pricing reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). The ticket's `true` is
 *   that protocol, not the mutation idempotency suite.
 */
import { defineActionContract } from "@showzy/core/contract";
import { LIST_GROUPS_SEARCH_MAX } from "@showzy/validation/customers";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

import { GROUP_NAME_MAX, groupViewSchema } from "./group-view.contract.js";

export { LIST_GROUPS_SEARCH_MAX };

export const LIST_GROUPS_DEFAULT_LIMIT = 20;
export const LIST_GROUPS_MAX_LIMIT = 50;
export const LIST_GROUPS_CURSOR_MAX = 200;

const listGroupsCursor = createCursorCodec({
  payload: z.object({
    sortOrder: z.number().int(),
    id: z.uuid(),
    name: z.string().min(1).max(GROUP_NAME_MAX),
  }),
  fields: [
    { key: "sortOrder", kind: "int" },
    { key: "id", kind: "uuid" },
    { key: "name", kind: "remainder" },
  ],
});

export function formatListGroupsCursor(
  sortOrder: number,
  id: string,
  name: string,
): string {
  return listGroupsCursor.encode({ sortOrder, id, name });
}

export function parseListGroupsCursor(
  cursor: string,
): { sortOrder: number; id: string; name: string } | undefined {
  return listGroupsCursor.decode(cursor);
}

export const listGroupsInputSchema = z.object({
  search: listSearchInput(LIST_GROUPS_SEARCH_MAX),
  limit: listLimitInput(LIST_GROUPS_MAX_LIMIT, LIST_GROUPS_DEFAULT_LIMIT),
  cursor: listCursorInput(parseListGroupsCursor, LIST_GROUPS_CURSOR_MAX),
});

export const listGroupsOutputSchema = z.object({
  items: z.array(groupViewSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listGroupsContract = defineActionContract({
  name: "customers.listGroups",
  description:
    "List customer groups in the staff member's active company. Order by sort_order ascending, then name, then id. Optional case-insensitive name search. Paginate with a sort-order/name/id cursor and a page size of at most 50. Each row is the group view (id, name, slug, description, price-list assignment, active member count, timestamps). Company id is never input. Groups are not archived.",
  principal: "staff",
  transport: "client",
  input: listGroupsInputSchema,
  output: listGroupsOutputSchema,
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
