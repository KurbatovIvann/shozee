import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  catalogNameSchema,
  currencyCodeSchema,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";
import { variantViewSchema } from "./variant-view.contract.js";

function overrideFieldState(
  value: string | null | undefined,
): "omitted" | "cleared" | "set" {
  if (value === undefined) {
    return "omitted";
  }
  return value === null ? "cleared" : "set";
}

export const updateVariantInputSchema = z
  .strictObject({
    productId: z.uuid(),
    variantId: z.uuid(),
    name: catalogNameSchema,
    basePriceMinor: nonNegativeMoneyWireSchema.nullable().optional(),
    currency: currencyCodeSchema.nullable().optional(),
  })
  .refine(
    (variant) =>
      overrideFieldState(variant.basePriceMinor) ===
      overrideFieldState(variant.currency),
    {
      message:
        "Variant price and currency must be omitted, null, or set together.",
    },
  );

export const updateVariantOutputSchema = variantViewSchema;

export const updateVariantContract = defineActionContract({
  name: "catalog.updateVariant",
  description:
    "Update the name and base-price override of a variant in the staff member's active company. Currency is UAH-only (MVP). The override pair is omitted to keep the stored override, null together to clear it, and set together to replace it. Missing, foreign-company, or product-mismatched variants fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateVariantInputSchema,
  output: updateVariantOutputSchema,
  permissions: ["products:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
