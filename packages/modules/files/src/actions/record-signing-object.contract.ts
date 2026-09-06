/**
 * Staff write: persist ready metadata for a verified ASiC-E after the
 * handshake PUT. Mechanical: `timeout: 15000` covers one GetObject +
 * SHA-256 of up to 25 MiB (security-operations.md §3), matching
 * finalize's API→R2 budget. Copy renderPdf atomic *shape* (internal
 * write, idempotent, audited) — not the system principal.
 * `atomicCallers: ["docSigning.complete"]` (SHO-258 / ADR-0021).
 * Tenant scope comes from staff membership; `companyId` is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { signingReadyViewSchema } from "./file-view.contract.js";
import {
  checksumSha256Schema,
  documentByteSizeSchema,
  signingMimeTypeSchema,
  signingPurposeSchema,
} from "../wire.contract.js";

export const recordSigningObjectInputSchema = z.object({
  fileId: z.uuid(),
  purpose: signingPurposeSchema,
  mimeType: signingMimeTypeSchema,
  byteSize: documentByteSizeSchema,
  checksumSha256: checksumSha256Schema,
});

export const recordSigningObjectOutputSchema = signingReadyViewSchema;

export const recordSigningObjectContract = defineActionContract({
  name: "files.recordSigningObject",
  description:
    "Record a ready private ASiC-E signing object after the handshake PUT and after docSigning.complete has verified the container. Updates the pending purpose=signing row in the active company with MIME application/vnd.etsi.asic-e+zip and uploaded_by_user_id of the signing staff user. The durable object key is server-derived ({companyId}/signing/{fileId}); staging {companyId}/uploads/{fileId} is never stored. A retry whose staging object is already gone succeeds when the durable signing object exists with matching checksum and size. Clients never supply a key, URL, bucket, or company id. Catalog and document purpose fail as not-found. A retry of an already-ready matching row returns the same view. Missing objects and foreign-company ids fail without leaking existence. Object keys and signed URLs are never returned.",
  principal: "staff",
  transport: "internal",
  input: recordSigningObjectInputSchema,
  output: recordSigningObjectOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: ["docSigning.complete"],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 15_000,
});
