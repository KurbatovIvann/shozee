/**
 * Staff write contract for SHO-185 (feature SHO-183): upsert product- and
 * variant-level prices on a price list. Card-named metadata: staff
 * principal, client transport, `pricing:manage`, write risk, exposed to
 * AI, no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.setProductImages` /
 * `catalog.createProduct` and the feature card:
 * - `timeout: 10000` — nested `catalog.getProductPricingFacts`
 *   (`timeout: 5000`) shares the remaining budget; raise the caller.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Batch min 1, max 200 (same ceiling as facts / resolve).
 * - Product-level rows omit `variantId`; variant-level rows require it.
 * - `priceMinor` is a canonical non-negative int64 money wire string;
 *   optional `currency` is UAH-only (db.md §11) and defaults to UAH.
 *   Stored `0` is a real price.
 * - Missing/foreign lists and missing/mismatched products or variants
 *   fail the whole batch with the same not-found.
 * - Output is `{ items }` of the upserted rows so the client has ids
 *   without a second round-trip (card named the input only).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  currencyCodeSchema,
  DEFAULT_PRICE_CURRENCY,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";
import { priceListEntryRowSchema } from "./list-price-list-entries.contract.js";

/** Batch ceiling shared with catalog facts / resolve (feature card). */
export const SET_PRICE_LIST_ENTRIES_MAX_ITEMS = 200;

export const setPriceListEntryInputSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  priceMinor: nonNegativeMoneyWireSchema,
  currency: currencyCodeSchema.default(DEFAULT_PRICE_CURRENCY),
});

export const setPriceListEntriesInputSchema = z.strictObject({
  priceListId: z.uuid(),
  entries: z
    .array(setPriceListEntryInputSchema)
    .min(1)
    .max(SET_PRICE_LIST_ENTRIES_MAX_ITEMS),
});

export const setPriceListEntriesOutputSchema = z.strictObject({
  items: z.array(priceListEntryRowSchema),
});

export const setPriceListEntriesContract = defineActionContract({
  name: "pricing.setPriceListEntries",
  description:
    "Upsert product-level and variant-level prices on a price list in the staff member's active company. Takes the list id and 1–200 entries (productId, optional variantId, non-negative minor-unit price, optional currency UAH defaulting to UAH). Product-level rows omit variantId; variant-level rows require it. Stored 0 is a real price. Missing lists, lists that belong to another company, and missing or mismatched products or variants fail the whole batch with the same not-found via catalog.getProductPricingFacts. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same rows without a second write.",
  principal: "staff",
  transport: "client",
  input: setPriceListEntriesInputSchema,
  output: setPriceListEntriesOutputSchema,
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
  timeout: 10_000,
});
