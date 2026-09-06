/**
 * Golden read-action contract (SHO-88 / pricing-T2). Later Executors copy
 * this file's shape. Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches catalog/customers facts. Nested `ctx.call`
 *   shares this remaining budget; five-level queries fit without raising it.
 * - Output wrapper is `{ prices: [...] }` in input order (one row per item).
 * - `sourceIds` names the provenance the card called "source ids":
 *   personal rows use `personalPriceId`; list hits use `priceListId` +
 *   `entryId`; base is an empty object.
 * - Money wire is `@showzy/validation/money` via `wire.contract.ts`.
 * - `resolverVersion` is the compile-time constant `1`.
 * - SHO-352 hides this helper from `/rpc` and AI tools
 *   (`transport: "internal"`, `aiExposure: "internal"`); only
 *   `orders.create` may `ctx.call` it.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { moneyWireSchema } from "../wire.contract.js";

/** Batch ceiling shared with catalog facts (feature card). */
export const RESOLVE_PRODUCT_PRICES_MAX_ITEMS = 200;

/** Compile-time resolver algorithm version (feature card). */
export const PRICING_RESOLVER_VERSION = 1;

const resolveProductPricesItemSchema = z.object({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
});

export const resolveProductPricesInputSchema = z.object({
  items: z
    .array(resolveProductPricesItemSchema)
    .min(1)
    .max(RESOLVE_PRODUCT_PRICES_MAX_ITEMS),
  customerId: z.uuid().optional(),
});

export const priceSourceSchema = z.enum([
  "personal",
  "customer_price_list",
  "group_price_list",
  "default_price_list",
  "base",
]);

export const matchLevelSchema = z.enum(["variant", "product"]);

export const resolvedPriceSourceIdsSchema = z.object({
  personalPriceId: z.uuid().optional(),
  priceListId: z.uuid().optional(),
  entryId: z.uuid().optional(),
});

export const resolvedPriceSchema = z.object({
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  unitPriceMinor: moneyWireSchema,
  currency: z.string().length(3),
  source: priceSourceSchema,
  matchLevel: matchLevelSchema,
  sourceIds: resolvedPriceSourceIdsSchema,
  resolverVersion: z.literal(PRICING_RESOLVER_VERSION),
});

export const resolveProductPricesOutputSchema = z.object({
  prices: z.array(resolvedPriceSchema),
});

export const resolveProductPricesContract = defineActionContract({
  name: "pricing.resolveProductPrices",
  description:
    "Resolve effective unit prices for a batch of products or variants in the staff member's active company. When a customer is named, walk the full five-level chain (personal → customer list → group list → company default list → catalog base); when omitted, use only the company default list then base. Inactive lists are skipped. Within a level a variant entry beats a product entry; a higher level always wins over a lower one. The whole batch fails with not-found when any product, named variant, or customer is missing or outside the company.",
  principal: "staff",
  transport: "internal",
  input: resolveProductPricesInputSchema,
  output: resolveProductPricesOutputSchema,
  permissions: ["pricing:view"],
  aiExposure: "internal",
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
