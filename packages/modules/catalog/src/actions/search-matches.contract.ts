/**
 * Internal catalog search matcher (SHO-527 / SHO-530). Variant hits
 * require `productId`. Handler SQL is T4.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  catalogSearchMatchesInputSchema,
  catalogSearchMatchesOutputSchema,
} from "@showzy/validation/search";

export const searchMatchesContract = defineActionContract({
  name: "catalog.searchMatches",
  description:
    "Return grouped search hits for products and variants in the staff member's active company. Variant hits include productId. Company id is never input. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: catalogSearchMatchesInputSchema,
  output: catalogSearchMatchesOutputSchema,
  permissions: ["products:view"],
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
