/**
 * Staff catalog get (SHO-135 / catalog-T7). Mechanical choices the feature
 * card left unnamed — copy them, do not invent a second product view:
 * - `timeout: 5000` matches the golden catalog reads (variants + media).
 * - Variants include archived rows and the nullable base-price override
 *   already stored on `product_variants` (needed by the later detail form).
 *   Staff detail order is `createdAt` then id, not the facts-action id sort.
 * - Image fileIds are ordered by `position` then media id (same primary
 *   as `listProducts` when positions tie). No signed URLs.
 * - Money refine is local: keep the regex in lockstep with
 *   `packages/contract/src/client/money-wire.ts` until validation owns it.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { moneyWireSchema, productStatusSchema } from "../wire.contract.js";

export const getProductInputSchema = z.object({
  productId: z.uuid(),
});

export const getProductVariantViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: productStatusSchema,
  basePriceMinor: moneyWireSchema.nullable(),
  currency: z.string().length(3).nullable(),
});

export const getProductOutputSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  basePriceMinor: moneyWireSchema,
  currency: z.string().length(3),
  status: productStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  variants: z.array(getProductVariantViewSchema),
  imageFileIds: z.array(z.uuid()),
});

export const getProductContract = defineActionContract({
  name: "catalog.getProduct",
  description:
    "Return one product in the staff member's active company, including every variant (archived variants included, each with status and a nullable base-price override) and the ordered image fileId list. Missing or foreign-company products fail with not-found. Clients fetch display URLs via files.getDownloadUrl — this action never returns URLs or object keys.",
  principal: "staff",
  transport: "client",
  input: getProductInputSchema,
  output: getProductOutputSchema,
  permissions: ["products:view"],
  aiExposure: "exposed",
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
