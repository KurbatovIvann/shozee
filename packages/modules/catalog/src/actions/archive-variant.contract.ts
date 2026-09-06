/**
 * Status-only staff write (SHO-134 / catalog-T6). Copies the ADR-0026
 * `orders.confirm` shape: one column, no confirmation, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other staff writes with no nested `ctx.call`.
 * - Output is `{ variantId, status: "archived" }` so the client does not
 *   need a second round-trip after the flip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const archiveVariantInputSchema = z.object({
  variantId: z.uuid(),
});

export const archiveVariantOutputSchema = z.object({
  variantId: z.uuid(),
  status: z.literal("archived"),
});

export const archiveVariantContract = defineActionContract({
  name: "catalog.archiveVariant",
  description:
    "Archive a product variant in the active company by setting status to archived. This is a status-only write: no other variant columns change, and the parent product status is not changed. A variant that is already archived is returned unchanged. Missing or foreign-company variants fail with not-found. Hard delete does not exist.",
  principal: "staff",
  transport: "client",
  input: archiveVariantInputSchema,
  output: archiveVariantOutputSchema,
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
