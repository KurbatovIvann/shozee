/**
 * Staff write contract for SHO-185 (feature SHO-183): remove product- and
 * variant-level prices from a price list. Card-named metadata: staff
 * principal, client transport, `pricing:manage`, write risk, exposed to
 * AI, no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from set and `catalog` writes:
 * - `timeout: 5000` — one delete batch, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Batch min 1, max 200. Missing entries are ignored (empty editor
 *   field is a remove, not a stored blank). There is no replace-all.
 * - Product-level rows omit `variantId`; variant-level rows require it.
 * - Missing/foreign lists fail with the same not-found.
 * - Output is `{ priceListId }` so the client has an ack without a
 *   second round-trip (card named the input only).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

/** Batch ceiling shared with set / catalog facts (feature card). */
export const REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS = 200;

export const removePriceListEntryInputSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
});

export const removePriceListEntriesInputSchema = z.strictObject({
  priceListId: z.uuid(),
  entries: z
    .array(removePriceListEntryInputSchema)
    .min(1)
    .max(REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS),
});

export const removePriceListEntriesOutputSchema = z.strictObject({
  priceListId: z.uuid(),
});

export const removePriceListEntriesContract = defineActionContract({
  name: "pricing.removePriceListEntries",
  description:
    "Remove product-level and variant-level prices from a price list in the staff member's active company. Takes the list id and 1–200 keys (productId plus optional variantId). Missing entries are ignored. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same ack without a second write.",
  principal: "staff",
  transport: "client",
  input: removePriceListEntriesInputSchema,
  output: removePriceListEntriesOutputSchema,
  permissions: ["pricing:manage"],
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
