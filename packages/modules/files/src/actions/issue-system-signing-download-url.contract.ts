/**
 * System tenant read: short-lived signed GET for a ready ASiC-E, nested
 * from `documents.attachSignedShare` only. Mechanical: `timeout: 5000`
 * matches the staff issuers. Callers do not exist yet (SHO-259); do not
 * register a `ctx.call` edge until then. Issuer `atomicCallers` stay
 * empty. Pending, missing, foreign, catalog, and document files are
 * not-found. The URL is not stored.
 */
import { defineActionContract } from "@showzy/core/contract";

import {
  issueSigningDownloadUrlInputSchema,
  issueSigningDownloadUrlOutputSchema,
} from "./issue-signing-download-url.contract.js";

export const issueSystemSigningDownloadUrlInputSchema =
  issueSigningDownloadUrlInputSchema;

export const issueSystemSigningDownloadUrlOutputSchema =
  issueSigningDownloadUrlOutputSchema;

export const issueSystemSigningDownloadUrlContract = defineActionContract({
  name: "files.issueSystemSigningDownloadUrl",
  description:
    "Return a short-lived signed GET URL for a ready private ASiC-E signing file in the enqueuing system tenant, for nesting from documents.attachSignedShare. Pending, missing, foreign-company, catalog, or document files fail with not-found. The URL uses Content-Disposition attachment and Content-Type application/vnd.etsi.asic-e+zip; the filename is document.asice. Company id is never input. Clients never receive or choose the object key as a durable field. The URL is not stored.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: issueSystemSigningDownloadUrlInputSchema,
  output: issueSystemSigningDownloadUrlOutputSchema,
  permissions: [],
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
