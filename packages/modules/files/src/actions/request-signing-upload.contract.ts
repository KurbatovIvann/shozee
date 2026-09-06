/**
 * Staff write: create a pending signing file and return its fileId.
 * Mechanical: `timeout: 5000` covers one insert. The signed PUT lives on
 * `files.getSigningUploadUrl`, not on this idempotent write (core.md §5).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  checksumSha256Schema,
  documentByteSizeSchema,
  signingMimeTypeSchema,
  signingPurposeSchema,
} from "../wire.contract.js";

export const requestSigningUploadInputSchema = z.object({
  purpose: signingPurposeSchema,
  mimeType: signingMimeTypeSchema,
  byteSize: documentByteSizeSchema,
  checksumSha256: checksumSha256Schema,
});

export const requestSigningUploadOutputSchema = z.object({
  fileId: z.uuid(),
});

export const requestSigningUploadContract = defineActionContract({
  name: "files.requestSigningUpload",
  description:
    "Create a pending private signing file in the active company and return its fileId. The durable object key is server-derived ({companyId}/signing/{fileId}); the handshake PUT targets {companyId}/uploads/{fileId} and is never stored on the row. Clients never supply a key, URL, or bucket. application/vnd.etsi.asic-e+zip up to 25 MiB is accepted. Call files.getSigningUploadUrl to mint a short-lived signed PUT; this write does not return a URL. Does not mark the object ready — catalog finalize is not used.",
  principal: "staff",
  transport: "client",
  input: requestSigningUploadInputSchema,
  output: requestSigningUploadOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: true,
  timeout: 5_000,
});
