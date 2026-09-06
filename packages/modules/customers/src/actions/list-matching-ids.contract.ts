/**
 * Internal CRM id match for `orders.list` query (SHO-351 / ADR-0033).
 * Bounded single SELECT — not a drain of `customers.listCustomers` pages.
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other customers facts reads.
 * - Cap `LIST_MATCHING_IDS_MAX` (500) is the previous orders.list drain
 *   ceiling (10 × 50) as one LIMIT; `truncated` is set when more match.
 * - Status is all (active + archived): list search is not the T2
 *   query-path resolve (active-only).
 * - Query unique-match normalize (NFC, trim, collapse whitespace) then
 *   name token-AND of `nameSearchStems` as word-prefix `ilike` (SHO-396 /
 *   SHO-398) OR phone/email full-string contains. LIKE metacharacters
 *   are stripped; a query that strips to empty returns no ids.
 */
import { defineActionContract } from "@showzy/core/contract";
import { LIST_CUSTOMERS_SEARCH_MAX } from "@showzy/validation/customers";
import { z } from "zod";

export const LIST_MATCHING_IDS_MAX = 500;
export const LIST_MATCHING_IDS_QUERY_MAX = LIST_CUSTOMERS_SEARCH_MAX;

export const listMatchingIdsInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(LIST_MATCHING_IDS_QUERY_MAX),
});

export const listMatchingIdsOutputSchema = z.strictObject({
  ids: z.array(z.uuid()),
  truncated: z.boolean(),
});

export const listMatchingIdsContract = defineActionContract({
  name: "customers.listMatchingIds",
  description:
    "Return a bounded list of CRM customer ids in the staff member's active company whose name matches every token stem or whose phone or email contains the query. Used by orders.list search. Truncated is true when more than 500 customers match. Company id is never input. Does not return customer views.",
  principal: "staff",
  transport: "internal",
  input: listMatchingIdsInputSchema,
  output: listMatchingIdsOutputSchema,
  permissions: ["customers:view"],
  aiExposure: "internal",
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
