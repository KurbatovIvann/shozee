/**
 * Staff internal read: short-lived signed GET for a ready ASiC-E.
 * Panel path — `documents:view`, not `files:view` (employees have no
 * files:view). Mechanical: `timeout: 5000` is one tenant-scoped lookup
 * plus local presign, copied from `files.issueDocumentDownloadUrl`.
 * Pending, missing, foreign, catalog, and document files are not-found.
 * Authorization is rechecked when the URL is issued. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { getDownloadUrlOutputSchema } from "./get-download-url.contract.js";

export const issueSigningDownloadUrlInputSchema = z.object({
  fileId: z.uuid(),
});

export const issueSigningDownloadUrlOutputSchema = getDownloadUrlOutputSchema;

export const issueSigningDownloadUrlContract = defineActionContract({
  name: "files.issueSigningDownloadUrl",
  description:
    "Return a short-lived signed GET URL for a ready private ASiC-E signing file in the active company. Panel path: requires documents:view, not files:view. Pending, missing, foreign-company, catalog, or document files fail with not-found. The URL uses Content-Disposition attachment and Content-Type application/vnd.etsi.asic-e+zip; the filename is document.asice. Clients never receive or choose the object key as a durable field. The URL is not stored.",
  principal: "staff",
  transport: "internal",
  input: issueSigningDownloadUrlInputSchema,
  output: issueSigningDownloadUrlOutputSchema,
  permissions: ["documents:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
