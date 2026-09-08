/**
 * Staff company search (SHO-527 / feature SHO-526). Mechanical:
 * - `timeout: 10000` covers sequential matcher fan-out (T8).
 * - `permissions: ["companies:view"]` opens search (T0 key; not `[]`,
 *   not a new `search:query` key). Type gates stay `staffHasPermission` (T8).
 * - `aiExposure: "exposed"` (T9 / SHO-535). `audit: false`. No cursor.
 * - Empty / punctuation-only after normalize is an empty result, not error.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  searchQueryInputSchema,
  searchQueryOutputSchema,
} from "@showzy/validation/search";

export const queryContract = defineActionContract({
  name: "search.query",
  description:
    "Search the staff member's active company for orders, customers, groups, counterparties, products, variants, price lists, and documents by name, number, phone, email, or ЄДРПОУ. Returns grouped hits with searchedTypes and queryNormalized. Company id is never input. Missing companies:view denies the whole action. Per-type rights are applied by the orchestrator. Empty after normalize returns no groups and does not query matchers.",
  principal: "staff",
  transport: "client",
  input: searchQueryInputSchema,
  output: searchQueryOutputSchema,
  permissions: ["companies:view"],
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
