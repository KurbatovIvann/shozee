/**
 * Golden facts contract for later Executors (SHO-87 / pricing-T2).
 *
 * Mechanical choices the feature card left unnamed — copy them, do not invent
 * a second shape:
 * - `timeout: 5000` is the fixture default. A later `ctx.call` from pricing
 *   shares this remaining budget; raise the *caller's* timeout if the
 *   combined read is tight.
 * - Input is resolve's `customerId` (required here). Pricing omits the call
 *   when resolve has no customer (levels 4–5 only).
 * - Output is the customer's list/group assignment in one row
 *   (`priceListId`, `groupId`, `groupPriceListId`) — not catalog's
 *   `{ products }` wrapper. Null means that level is unassigned; pricing
 *   skips inactive lists after this read.
 * - No money fields. Modules must not import `@showzy/contract`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const getCustomerPricingFactsInputSchema = z.object({
  customerId: z.uuid(),
});

export const getCustomerPricingFactsOutputSchema = z.object({
  priceListId: z.uuid().nullable(),
  groupId: z.uuid().nullable(),
  groupPriceListId: z.uuid().nullable(),
});

export const getCustomerPricingFactsContract = defineActionContract({
  name: "customers.getCustomerPricingFacts",
  description:
    "Return CRM pricing-assignment facts for one customer in the staff member's active company: the customer's price list, group, and the group's price list. Missing or foreign customers fail with not-found.",
  principal: "staff",
  transport: "internal",
  input: getCustomerPricingFactsInputSchema,
  output: getCustomerPricingFactsOutputSchema,
  permissions: ["customers:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
