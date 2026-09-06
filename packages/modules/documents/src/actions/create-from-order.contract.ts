/**
 * Staff write `documents.createFromOrder` (SHO-231 / feature SHO-227;
 * layout + basis: SHO-365 / feature SHO-362). Copy `orders.create`
 * (golden write). Mechanical choices the feature card left unnamed:
 * - Output is the created document view (snapshots + items) so the client
 *   has the issued row without a second round-trip. Later `documents.get`
 *   reuses `documentViewSchema`.
 * - `timeout: 15000` covers nested `orders.get` (2000) +
 *   `companies.getSellerFacts` (5000) + one of `customers.getCounterparty`
 *   / `customers.getCustomer` (5000) + `docGeneration.resolveLayout`
 *   (2000) sharing the remaining budget, then the write.
 * - `template_name` snapshots the canonical system layout key (not an
 *   FK). Omit `layoutKey` → type default (`payment_invoice.branded` /
 *   `delivery_note.parties`) via nested `docGeneration.resolveLayout`.
 * - Optional `basis` is create-time «Підстава»: trim, max 500, empty
 *   string stored as null.
 * - Input is a strict object so `companyId` cannot be smuggled in
 *   (ADR-0013).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  DOCUMENT_BASIS_MAX,
  documentTypeSchema,
  documentViewSchema,
} from "./document-view.contract.js";

export const createFromOrderInputSchema = z.strictObject({
  orderId: z.uuid(),
  type: documentTypeSchema,
  counterpartyId: z.uuid().optional(),
  layoutKey: z.string().trim().min(1).optional(),
  basis: z.string().trim().max(DOCUMENT_BASIS_MAX).optional(),
});

export const createFromOrderOutputSchema = documentViewSchema;

export const createFromOrderContract = defineActionContract({
  name: "documents.createFromOrder",
  description:
    "Issue a payment invoice or delivery note from a staff order in the active company. Copies immutable order line snapshots (no reprice); snapshots seller legal requisites from getSellerFacts and the buyer as either a counterparty legal face or the CRM customer display name. Assigns the next per-type document number (prefix, type code, sequence — no year) and the Europe/Kyiv calendar day. Optional layoutKey selects a system look; omit it to persist the type default (branded invoice or parties waybill). Optional basis is the create-time Підстава snapshot (trim, max 500). Fails when the order is canceled, seller legal is missing, a live document of that type already exists for the order, the counterparty is linked to a different customer, the order has no customer and no counterparty, or the layout key is unknown or does not match the document type.",
  principal: "staff",
  transport: "client",
  input: createFromOrderInputSchema,
  output: createFromOrderOutputSchema,
  permissions: ["documents:create"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["documents.created"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 15_000,
});
