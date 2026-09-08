/**
 * Internal price-list search matcher (SHO-527 / SHO-532). Matcher SQL is
 * SHO-532 (T6): name-only FTS + trgm on `price_lists.name`.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  pricingSearchMatchesInputSchema,
  pricingSearchMatchesOutputSchema,
} from "@showzy/validation/search";

export const searchMatchesContract = defineActionContract({
  name: "pricing.searchMatches",
  description:
    "Return grouped search hits for price lists in the staff member's active company. Company id is never input. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: pricingSearchMatchesInputSchema,
  output: pricingSearchMatchesOutputSchema,
  permissions: ["pricing:view"],
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
