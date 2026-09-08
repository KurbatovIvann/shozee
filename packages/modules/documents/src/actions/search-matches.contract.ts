/**
 * Internal document-number search matcher (SHO-527 / SHO-533). Prefix via
 * `ctx.call(companies.get)` — composition edge declared in apps/api.
 * Does not reuse the order-number canonicalize. Identifier-layer SQL is
 * SHO-533 (T7).
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  documentsSearchMatchesInputSchema,
  documentsSearchMatchesOutputSchema,
} from "@showzy/validation/search";

export const searchMatchesContract = defineActionContract({
  name: "documents.searchMatches",
  description:
    "Return grouped search hits for documents in the staff member's active company by document number. Reads numbering prefix from companies.get. Company id is never input. Internal — not mounted on HTTP. Does not use the order-number canonicalize.",
  principal: "staff",
  transport: "internal",
  input: documentsSearchMatchesInputSchema,
  output: documentsSearchMatchesOutputSchema,
  permissions: ["documents:view"],
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
