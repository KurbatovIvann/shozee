/**
 * Internal CRM search matcher (SHO-527 / SHO-529). Sibling of
 * `customers.listMatchingIds` — not an extension; `orders.list` stays
 * on listMatchingIds. Handler SQL is T3; this ticket is the contract.
 *
 * `orderCustomerLookup` is a separate object from display group
 * `truncated` (limitPerType). Lookup cap 20; truncated iff more than 20
 * customer ids match.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  customersSearchMatchesInputSchema,
  customersSearchMatchesOutputSchema,
} from "@showzy/validation/search";

export const searchMatchesContract = defineActionContract({
  name: "customers.searchMatches",
  description:
    "Return grouped search hits for customers, customer groups, and counterparties in the staff member's active company, plus orderCustomerLookup customer ids (cap 20) for orders.searchMatches. Company id is never input. Internal — not mounted on HTTP. Does not replace customers.listMatchingIds.",
  principal: "staff",
  transport: "internal",
  input: customersSearchMatchesInputSchema,
  output: customersSearchMatchesOutputSchema,
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
