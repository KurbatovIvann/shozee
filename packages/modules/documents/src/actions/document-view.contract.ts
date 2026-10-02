/**
 * Shared staff document view (SHO-231 / feature SHO-227). Create returns
 * this shape so later `documents.get` does not invent a second projection.
 *
 * Buyer is a discriminated snapshot: counterparty legal face or CRM
 * display name only. Seller is the legal face from `getSellerFacts`.
 * Totals are sums of persisted line snapshots (no reprice). Optional
 * `basis` is the create-time «Підстава» snapshot (SHO-365).
 */
import { z } from "zod";

import {
  calendarDaySchema,
  moneyWireSchema,
  quantityMilliWireSchema,
} from "../wire.contract.js";

export const documentTypeSchema = z.enum(["payment_invoice", "delivery_note"]);

export const documentStatusSchema = z.enum(["issued", "cancelled"]);

export const documentDiscountKindSchema = z.literal("none");

export const documentTaxTreatmentSchema = z.enum([
  "exempt",
  "inclusive",
  "exclusive",
]);

export const documentCompanyTypeSchema = z.enum(["fop", "tov"]);

export const DOCUMENT_BASIS_MAX = 500;

export const DOCUMENT_LAYOUT_KEY_MAX = 120;

export const documentTemplateSourceSchema = z.literal("system");

export const supplierDetailsSchema = z.object({
  kind: z.literal("seller"),
  name: z.string().min(1),
  prefix: z.string().min(1),
  companyType: documentCompanyTypeSchema,
  legalName: z.string().nullable(),
  edrpou: z.string().nullable(),
  legalAddress: z.string().nullable(),
  iban: z.string().nullable(),
  bankName: z.string().nullable(),
  bankMfo: z.string().nullable(),
  bankEdrpou: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});

export const counterpartyBuyerDetailsSchema = z.object({
  kind: z.literal("counterparty"),
  name: z.string().min(1),
  edrpou: z.string().nullable(),
  legalAddress: z.string().nullable(),
  iban: z.string().nullable(),
  bankName: z.string().nullable(),
  bankMfo: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
});

export const customerBuyerDetailsSchema = z.object({
  kind: z.literal("customer"),
  displayName: z.string().min(1),
});

export const buyerDetailsSchema = z.discriminatedUnion("kind", [
  counterpartyBuyerDetailsSchema,
  customerBuyerDetailsSchema,
]);

export const documentItemViewSchema = z.object({
  itemId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid().nullable(),
  titleSnapshot: z.string().min(1),
  quantityMilli: quantityMilliWireSchema,
  unitPriceMinor: moneyWireSchema,
  discountKind: documentDiscountKindSchema,
  discountValue: moneyWireSchema,
  discountAmountMinor: moneyWireSchema,
  taxTreatment: documentTaxTreatmentSchema,
  taxRateBp: z.number().int().nonnegative(),
  taxAmountMinor: moneyWireSchema,
  netAmountMinor: moneyWireSchema,
  grossAmountMinor: moneyWireSchema,
  currency: z.string().length(3),
});

export const documentViewSchema = z.object({
  documentId: z.uuid(),
  orderId: z.uuid(),
  counterpartyId: z.uuid().nullable(),
  type: documentTypeSchema,
  status: documentStatusSchema,
  documentNumber: z.string().min(1),
  issuedOn: calendarDaySchema,
  supplierDetails: supplierDetailsSchema,
  buyerDetails: buyerDetailsSchema,
  totalNetMinor: moneyWireSchema,
  totalTaxMinor: moneyWireSchema,
  totalGrossMinor: moneyWireSchema,
  currency: z.string().length(3),
  templateSource: documentTemplateSourceSchema,
  templateName: z.string().min(1),
  basis: z.string().min(1).max(DOCUMENT_BASIS_MAX).nullable(),
  createdAt: z.iso.datetime(),
  items: z.array(documentItemViewSchema).min(1),
});

/**
 * Generation chip on `documents.get` (SHO-236 fills this from
 * `docGeneration.getArtifact`). Status values match the jobs CHECK
 * (`pending` | `ready` | `failed`).
 */
export const documentGenerationStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
]);

export const documentGenerationViewSchema = z.object({
  status: documentGenerationStatusSchema,
  fileId: z.uuid().nullable(),
});

/**
 * Signing chip on `documents.get` (SHO-256 fills this from
 * `docSigning.get`). Status values match the signing-owned projection
 * (`unsigned` | `pending` | `supplier_signed`).
 */
export const documentSigningStatusSchema = z.enum([
  "unsigned",
  "pending",
  "supplier_signed",
]);

export const documentSigningViewSchema = z.object({
  status: documentSigningStatusSchema,
  requestId: z.uuid().optional(),
  signedFileId: z.uuid().optional(),
});
