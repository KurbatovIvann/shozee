/**
 * Status-only staff write (SHO-134 / catalog-T6). Copies the ADR-0026
 * `orders.confirm` shape: one column, no confirmation, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other staff writes with no nested `ctx.call`.
 * - Output is `{ productId, status: "archived" }` so the client does not
 *   need a second round-trip after the flip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const archiveProductInputSchema = z.object({
  productId: z.uuid(),
});

export const archiveProductOutputSchema = z.object({
  productId: z.uuid(),
  status: z.literal("archived"),
});

export const archiveProductContract = defineActionContract({
  name: "catalog.archiveProduct",
  description:
    "Archive a product in the active company by setting status to archived. This is a status-only write: no other product columns change, and variants are not archived (the product-level status already hides them from sale). A product that is already archived is returned unchanged. Missing or foreign-company products fail with not-found. Hard delete does not exist.",
  principal: "staff",
  transport: "client",
  input: archiveProductInputSchema,
  output: archiveProductOutputSchema,
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
