/**
 * Internal order search matcher (SHO-527 / SHO-531). Optional
 * `customerIds` from customers.searchMatches lookup. Prefix via
 * `ctx.call(companies.get)` — composition edge declared in apps/api.
 * Handler SQL is T5. Does not ctx.call customers.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  ordersSearchMatchesInputSchema,
  ordersSearchMatchesOutputSchema,
} from "@showzy/validation/search";

export const searchMatchesContract = defineActionContract({
  name: "orders.searchMatches",
  description:
    "Return grouped search hits for orders in the staff member's active company by order number, optional customerIds, or customer_name_snapshot. Reads numbering prefix from companies.get. Company id is never input. Internal — not mounted on HTTP. Does not call customers.",
  principal: "staff",
  transport: "internal",
  input: ordersSearchMatchesInputSchema,
  output: ordersSearchMatchesOutputSchema,
  permissions: ["orders:view"],
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
