import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const LIST_NAME_INDEX_PRICE_LISTS_MAX = 1_000;

const priceListEntrySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
});

export const listNameIndexInputSchema = z.strictObject({});

export const listNameIndexOutputSchema = z.strictObject({
  priceLists: z.strictObject({
    items: z.array(priceListEntrySchema),
    truncated: z.boolean(),
  }),
});

export const listNameIndexContract = defineActionContract({
  name: "pricing.listNameIndex",
  description:
    "Return every active price list in the staff member's active company as ids and names only, for the Шо parse context (ADR-0051). Deactivated price lists are excluded, as in the SHO-732 benchmark. The list is capped (1000 price lists) and sets truncated when more rows exist. Company id is never input. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: listNameIndexInputSchema,
  output: listNameIndexOutputSchema,
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
