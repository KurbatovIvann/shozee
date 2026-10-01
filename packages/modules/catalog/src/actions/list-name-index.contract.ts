import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const LIST_NAME_INDEX_PRODUCTS_MAX = 20_000;
export const LIST_NAME_INDEX_VARIANTS_MAX = 100_000;

const productEntrySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
});

const variantEntrySchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  name: z.string().min(1),
});

export const listNameIndexInputSchema = z.strictObject({});

export const listNameIndexOutputSchema = z.strictObject({
  products: z.strictObject({
    items: z.array(productEntrySchema),
    truncated: z.boolean(),
  }),
  variants: z.strictObject({
    items: z.array(variantEntrySchema),
    truncated: z.boolean(),
  }),
});

export const listNameIndexContract = defineActionContract({
  name: "catalog.listNameIndex",
  description:
    "Return every active product and every active product variant in the staff member's active company as ids and names only, for the Шо parse context (ADR-0051). Variant entries carry productId. Archived products and variants are excluded. Each list is capped (20000 products, 100000 variants) and sets truncated when more rows exist. Company id is never input. Internal — not mounted on HTTP.",
  principal: "staff",
  transport: "internal",
  input: listNameIndexInputSchema,
  output: listNameIndexOutputSchema,
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
