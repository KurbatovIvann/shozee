/**
 * Staff internal read: short-lived signed GET for a ready document PDF,
 * nested from `documents.share` only. Same bytes as
 * `files.issueDocumentDownloadUrl`; gated by `files:view`. Mechanical:
 * `timeout: 5000` matches the panel issuer. Do not add public+internal
 * (core rejects it). Pending, missing, foreign, and catalog files are
 * not-found. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";

import { getDownloadUrlOutputSchema } from "./get-download-url.contract.js";
import { issueDocumentDownloadUrlInputSchema } from "./issue-document-download-url.contract.js";

export const issueShareDownloadUrlInputSchema =
  issueDocumentDownloadUrlInputSchema;

export const issueShareDownloadUrlOutputSchema = getDownloadUrlOutputSchema;

export const issueShareDownloadUrlContract = defineActionContract({
  name: "files.issueShareDownloadUrl",
  description:
    "Return a short-lived signed GET URL for a ready private generated-document PDF in the active company, for nesting from documents.share. Requires files:view. Pending, missing, foreign-company, or catalog files fail with not-found. Same bytes and inline PDF disposition as files.issueDocumentDownloadUrl. Clients never receive or choose the object key as a durable field. The URL is not stored.",
  principal: "staff",
  transport: "internal",
  input: issueShareDownloadUrlInputSchema,
  output: issueShareDownloadUrlOutputSchema,
  permissions: ["files:view"],
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
