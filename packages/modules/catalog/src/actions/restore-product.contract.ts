/**
 * Status-only staff write (SHO-134 / catalog-T6). Copies the ADR-0026
 * `orders.confirm` shape: one column, no confirmation, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other staff writes with no nested `ctx.call`.
 * - Output is `{ productId, status: "active" }` so the client does not
 *   need a second round-trip after the flip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const restoreProductInputSchema = z.object({
  productId: z.uuid(),
});

export const restoreProductOutputSchema = z.object({
  productId: z.uuid(),
  status: z.literal("active"),
});

export const restoreProductContract = defineActionContract({
  name: "catalog.restoreProduct",
  description:
    "Restore an archived product in the active company by setting status to active. This is a status-only write: no other product columns change, and variants are not restored. A product that is already active is returned unchanged. Missing or foreign-company products fail with not-found. Hard delete does not exist.",
  principal: "staff",
  transport: "client",
  input: restoreProductInputSchema,
  output: restoreProductOutputSchema,
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
