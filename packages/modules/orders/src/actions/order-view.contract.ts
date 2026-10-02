import { z } from "zod";

import { moneyWireSchema, quantityMilliWireSchema } from "../wire.contract.js";

export const orderStatusSchema = z.enum([
  "new",
  "confirmed",
  "in_progress",
  "done",
  "canceled",
]);

export const orderDiscountKindSchema = z.literal("none");

export const orderTaxTreatmentSchema = z.enum([
  "exempt",
  "inclusive",
  "exclusive",
]);

export const orderPriceSourceSchema = z.enum([
  "personal",
  "customer_price_list",
  "group_price_list",
  "default_price_list",
  "base",
]);

export const orderItemViewSchema = z.object({
  itemId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  titleSnapshot: z.string().min(1),
  quantityMilli: quantityMilliWireSchema,
  unitPriceMinor: moneyWireSchema,
  discountKind: orderDiscountKindSchema,
  discountValue: moneyWireSchema,
  discountAmountMinor: moneyWireSchema,
  taxTreatment: orderTaxTreatmentSchema,
  taxRateBp: z.number().int().nonnegative(),
  taxAmountMinor: moneyWireSchema,
  netAmountMinor: moneyWireSchema,
  grossAmountMinor: moneyWireSchema,
  currency: z.string().length(3),
  priceSource: orderPriceSourceSchema,
  personalPriceId: z.uuid().nullable(),
  priceListId: z.uuid().nullable(),
  priceListEntryId: z.uuid().nullable(),
  resolverVersion: z.number().int().positive(),
});

export const orderViewSchema = z.object({
  orderId: z.uuid(),
  orderNumber: z.string().min(1),
  customerId: z.uuid().nullable(),
  customerNameSnapshot: z.string().min(1),
  status: orderStatusSchema,
  comment: z.string().max(2000).nullable(),
  totalNetMinor: moneyWireSchema,
  totalTaxMinor: moneyWireSchema,
  totalGrossMinor: moneyWireSchema,
  currency: z.string().length(3),
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  items: z.array(orderItemViewSchema).min(1),
});
