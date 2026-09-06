/**
 * Staff write: create a pending catalog file and return its fileId.
 * Mechanical: `timeout: 5000` covers one insert. The signed PUT lives on
 * `files.getUploadUrl`, not on this idempotent write (core.md §5).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  checksumSha256Schema,
  fileMimeTypeSchema,
  filePurposeSchema,
  uploadByteSizeSchema,
} from "../wire.contract.js";

export const requestUploadInputSchema = z.object({
  purpose: filePurposeSchema,
  mimeType: fileMimeTypeSchema,
  byteSize: uploadByteSizeSchema,
  checksumSha256: checksumSha256Schema,
});

export const requestUploadOutputSchema = z.object({
  fileId: z.uuid(),
});

export const requestUploadContract = defineActionContract({
  name: "files.requestUpload",
  description:
    "Create a pending private catalog file in the active company and return its fileId. The durable object key is server-derived ({companyId}/catalog/{fileId}); the handshake PUT targets {companyId}/uploads/{fileId} and is never stored on the row. Clients never supply a key, URL, or bucket. JPEG, PNG, and WebP up to 10 MiB are accepted. HEIC and other types fail validation. Call files.getUploadUrl to mint a short-lived signed PUT; this write does not return a URL.",
  principal: "staff",
  transport: "client",
  input: requestUploadInputSchema,
  output: requestUploadOutputSchema,
  permissions: ["files:upload"],
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
