/**
 * Staff internal layout resolve for `documents.createFromOrder` (SHO-363;
 * T9 / SHO-365 will `ctx.call` this). Input `layoutKey` may be a catalog
 * key or a legacy `template_name` alias. Output is the canonical key.
 * Unknown key or key/type mismatch is validation. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  documentLayoutKeySchema,
  documentLayoutTypeSchema,
} from "./layout.contract.js";

export const resolveLayoutInputSchema = z.strictObject({
  layoutKey: z.string().min(1),
  type: documentLayoutTypeSchema,
});

export const resolveLayoutOutputSchema = z.strictObject({
  key: documentLayoutKeySchema,
  type: documentLayoutTypeSchema,
});

export const resolveLayoutContract = defineActionContract({
  name: "docGeneration.resolveLayout",
  description:
    "Resolve a system PDF layout key for a payment invoice or delivery note in the staff member's active company. Accepts a catalog key or a legacy type alias and returns the canonical key. Unknown keys and key/type mismatches fail validation. Company id is never input. Nested from documents.createFromOrder; not a client route.",
  principal: "staff",
  transport: "internal",
  input: resolveLayoutInputSchema,
  output: resolveLayoutOutputSchema,
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
  timeout: 2_000,
});
