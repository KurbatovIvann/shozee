/**
 * Staff write contract for SHO-136 (feature SHO-130): replace a product's
 * ordered image list after `ctx.call files.getAttachmentFacts`.
 *
 * Card-named metadata: staff principal, client transport, `products:edit`,
 * write risk, exposed to AI, no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 10000` — nested `files.getAttachmentFacts` (`timeout: 5000`)
 *   shares the remaining budget; raise the *caller* (this action), not the
 *   facts action (files-T3 header note / orders.create).
 * - No `rateLimit` override — staff default 120/min per user.
 * - `fileIds` max 10 (ticket "~10"); empty clears the list. Duplicate ids
 *   fail Zod refine. `companyId` is never input (strict object).
 * - Output is `{ productId, fileIds }` in input order so the client does
 *   not need a second round-trip. Same field name as input; display URLs
 *   stay on `files.getDownloadUrl` / `catalog.getProduct`.
 * - Nested facts only returns JPEG/PNG/WebP (files `toReadyView`
 *   fail-closes undeclared MIME as INTERNAL). Catalog still rejects any
 *   non-image MIME facts might later admit (`rejectNonImageAttachments`).
 */
import { defineActionContract } from "@showzy/core/contract";
import { SET_PRODUCT_IMAGES_MAX } from "@showzy/validation/catalog";
import { z } from "zod";

export { SET_PRODUCT_IMAGES_MAX };

function uniqueFileIds(fileIds: readonly string[]): boolean {
  return new Set(fileIds).size === fileIds.length;
}

export const setProductImagesInputSchema = z.strictObject({
  productId: z.uuid(),
  fileIds: z.array(z.uuid()).max(SET_PRODUCT_IMAGES_MAX).refine(uniqueFileIds, {
    message: "Duplicate fileIds are not allowed.",
  }),
});

export const setProductImagesOutputSchema = z.strictObject({
  productId: z.uuid(),
  fileIds: z.array(z.uuid()).max(SET_PRODUCT_IMAGES_MAX),
});

export const setProductImagesContract = defineActionContract({
  name: "catalog.setProductImages",
  description:
    "Replace the ordered product image list for a product in the staff member's active company. Takes the product id and an ordered fileIds array (empty clears). Pending, missing, or foreign files fail the whole batch with not-found via files.getAttachmentFacts. Facts only returns JPEG/PNG/WebP, all of which are images. Duplicate fileIds fail validation. Company id is never input. Object keys and signed URLs are never stored or returned. Re-submitting the identical payload with the same idempotency key returns the same ordered set without a second write.",
  principal: "staff",
  transport: "client",
  input: setProductImagesInputSchema,
  output: setProductImagesOutputSchema,
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
  timeout: 10_000,
});
