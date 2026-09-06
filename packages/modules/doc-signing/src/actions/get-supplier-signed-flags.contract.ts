/**
 * Staff internal batch flags (SHO-254 / feature SHO-251). Nested from
 * `documents.list` only (SHO-256). One SELECT with `inArray` over a page
 * of ids (max 50) — the EXISTS-per-page the card named; not N+1 get.
 * Mechanical: `timeout: 5000` matches `files.getAttachmentFacts`. Empty
 * input returns an empty flags array without querying. Keep off the
 * contract client router.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const SUPPLIER_SIGNED_FLAGS_MAX_IDS = 50;

export const getSupplierSignedFlagsInputSchema = z.strictObject({
  documentIds: z.array(z.uuid()).max(SUPPLIER_SIGNED_FLAGS_MAX_IDS),
});

export const supplierSignedFlagSchema = z.object({
  documentId: z.uuid(),
  supplierSigned: z.boolean(),
});

export const getSupplierSignedFlagsOutputSchema = z.object({
  flags: z.array(supplierSignedFlagSchema),
});

export const getSupplierSignedFlagsContract = defineActionContract({
  name: "docSigning.getSupplierSignedFlags",
  description:
    "Return supplierSigned flags for a page of document ids in the active company (max 50). One query; output is flags only, unique first-seen order. Missing and foreign ids are false, not an error. Nested from documents.list only. Company id is never input.",
  principal: "staff",
  transport: "internal",
  input: getSupplierSignedFlagsInputSchema,
  output: getSupplierSignedFlagsOutputSchema,
  permissions: ["documents:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
});
