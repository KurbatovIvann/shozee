/**
 * Staff internal read of pending purpose=signing staging bytes for
 * `docSigning.complete` (SHO-258 / feature SHO-251). GetObject of
 * `{companyId}/uploads/{fileId}` up to 25 MiB. When staging is gone and
 * the row is still pending, falls back to the durable
 * `{companyId}/signing/{fileId}` object so complete can recover from a
 * crashed promote. Tenant scope comes from staff membership; `companyId`
 * is never input. Keep off the contract client router. Mechanical:
 * `timeout: 15000` matches recordSigningObject (one GetObject of the
 * document-class ceiling).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  checksumSha256Schema,
  documentByteSizeSchema,
  signingMimeTypeSchema,
} from "../wire.contract.js";

export const pendingSigningBytesSchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
  { error: "Expected staging object bytes" },
);

export const readPendingSigningObjectInputSchema = z.strictObject({
  fileId: z.uuid(),
});

export const readPendingSigningObjectOutputSchema = z.strictObject({
  fileId: z.uuid(),
  mimeType: signingMimeTypeSchema,
  byteSize: documentByteSizeSchema,
  checksumSha256: checksumSha256Schema,
  bytes: pendingSigningBytesSchema,
});

export const readPendingSigningObjectContract = defineActionContract({
  name: "files.readPendingSigningObject",
  description:
    "Return the pending purpose=signing object bytes for a file in the active company so docSigning.complete can verify the ASiC-E. Staging lives at {companyId}/uploads/{fileId} and is never the durable object_key. When staging is missing and the row is still pending, the durable {companyId}/signing/{fileId} object is returned (crash after copy, TX rolled back). Ready, missing, foreign-company, catalog, and document rows fail with not-found. Objects larger than 25 MiB fail validation. Object keys and signed URLs are never returned. Internal staff read; not a client route. Company id is never input.",
  principal: "staff",
  transport: "internal",
  input: readPendingSigningObjectInputSchema,
  output: readPendingSigningObjectOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 15_000,
});
