/**
 * Staff price-list list (SHO-171 / pricing-T3, widened SHO-184 / pricing-T4).
 * Mechanical choices for *this* picker page. Copy pagination **helpers**,
 * not this input bag, when building a staff+AI list (ADR-0033).
 * - Pagination is a stable `(isDefault desc, name asc, id asc)` cursor,
 *   not offset. `limit` defaults to 20 and caps at 50.
 * - Cursor payload is `0|id|name` / `1|id|name` so the name (which may
 *   contain `|`) is the remainder after the second separator.
 * - `name` is capped at 120, same as catalog / companies writes.
 * - Name search is optional, case-insensitive Drizzle `ilike`. LIKE
 *   metacharacters `%`, `_`, and `\\` in the query are stripped so they
 *   cannot widen or escape the match; a query that strips to empty
 *   returns no rows.
 * - `availability` defaults to `all` so inactive lists stay listed
 *   (customers `ctx.call` with `{}` / `{ limit }` must keep working).
 * - Additive `entryCount` is the row count of `price_list_entries`.
 *   Assignment counts are out of scope.
 * - `timeout: 5000` matches the golden pricing/catalog reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md treats reads as
 *   naturally idempotent (no key, no storage). The ticket's `true` is
 *   that protocol, not the mutation idempotency suite.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  createCursorCodec,
  listCursorInput,
  listLimitInput,
  listSearchInput,
} from "@showzy/validation/pagination";
import { z } from "zod";

export const LIST_PRICE_LISTS_DEFAULT_LIMIT = 20;
export const LIST_PRICE_LISTS_MAX_LIMIT = 50;
export const LIST_PRICE_LISTS_QUERY_MAX = 100;
export const PRICE_LIST_NAME_MAX = 120;
export const LIST_PRICE_LISTS_CURSOR_MAX = 200;

const listPriceListsCursor = createCursorCodec({
  payload: z.object({
    isDefault: z.boolean(),
    id: z.uuid(),
    name: z.string().min(1).max(PRICE_LIST_NAME_MAX),
  }),
  fields: [
    { key: "isDefault", kind: "booleanFlag" },
    { key: "id", kind: "uuid" },
    { key: "name", kind: "remainder" },
  ],
});

export function formatListPriceListsCursor(
  isDefault: boolean,
  id: string,
  name: string,
): string {
  return listPriceListsCursor.encode({ isDefault, id, name });
}

export function parseListPriceListsCursor(
  cursor: string,
): { isDefault: boolean; id: string; name: string } | undefined {
  return listPriceListsCursor.decode(cursor);
}

export const listPriceListsAvailabilitySchema = z.enum([
  "all",
  "active",
  "inactive",
]);

export const listPriceListsInputSchema = z.object({
  query: listSearchInput(LIST_PRICE_LISTS_QUERY_MAX),
  availability: listPriceListsAvailabilitySchema.default("all"),
  limit: listLimitInput(
    LIST_PRICE_LISTS_MAX_LIMIT,
    LIST_PRICE_LISTS_DEFAULT_LIMIT,
  ),
  cursor: listCursorInput(
    parseListPriceListsCursor,
    LIST_PRICE_LISTS_CURSOR_MAX,
  ),
});

export const listPriceListRowSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(PRICE_LIST_NAME_MAX),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  entryCount: z.number().int().nonnegative(),
});

export const listPriceListsOutputSchema = z.object({
  items: z.array(listPriceListRowSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const listPriceListsContract = defineActionContract({
  name: "pricing.listPriceLists",
  description:
    "List price lists in the staff member's active company. Default availability all includes inactive lists; pass availability active or inactive to filter. Optional case-insensitive name search. Paginate with a default/name/id cursor and a page size of at most 50. Each row includes id, name, isDefault, isActive, and entryCount. Company id is never input. Does not return assignment counts.",
  principal: "staff",
  transport: "client",
  input: listPriceListsInputSchema,
  output: listPriceListsOutputSchema,
  permissions: ["pricing:view"],
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
