/**
 * Staff internal read: short-lived signed GET for a ready ASiC-E,
 * nested from `documents.share` only. Same bytes as
 * `files.issueSigningDownloadUrl`; gated by `files:view`. Mechanical:
 * `timeout: 5000` matches the panel issuer. Do not add public+internal
 * (core rejects it). Pending, missing, foreign, catalog, and document
 * files are not-found. The URL is not stored. Issuer `atomicCallers`
 * stay empty (not an atomic edge).
 */
import { defineActionContract } from "@showzy/core/contract";

import {
  issueSigningDownloadUrlInputSchema,
  issueSigningDownloadUrlOutputSchema,
} from "./issue-signing-download-url.contract.js";

export const issueShareSigningDownloadUrlInputSchema =
  issueSigningDownloadUrlInputSchema;

export const issueShareSigningDownloadUrlOutputSchema =
  issueSigningDownloadUrlOutputSchema;

export const issueShareSigningDownloadUrlContract = defineActionContract({
  name: "files.issueShareSigningDownloadUrl",
  description:
    "Return a short-lived signed GET URL for a ready private ASiC-E signing file in the active company, for nesting from documents.share. Requires files:view. Pending, missing, foreign-company, catalog, or document files fail with not-found. Same bytes and attachment document.asice disposition as files.issueSigningDownloadUrl. Clients never receive or choose the object key as a durable field. The URL is not stored.",
  principal: "staff",
  transport: "internal",
  input: issueShareSigningDownloadUrlInputSchema,
  output: issueShareSigningDownloadUrlOutputSchema,
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
