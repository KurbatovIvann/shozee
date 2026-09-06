/**
 * Staff share (SHO-235 / feature SHO-227). Rotates the active 90-day page
 * token and pre-mints a short-lived PDF GET via nested
 * `files.issueShareDownloadUrl`. When a supplier ASiC exists, also
 * pre-mints `signedDownloadUrl` via nested
 * `files.issueShareSigningDownloadUrl`. Output is the document view plus the
 * plaintext token once and `https://<origin>/d/{token}`. Raw token and
 * signed URL must not appear in logs or audit.
 *
 * Mechanical: `timeout: 10000` — nested issuer is 5000. No rate-limit
 * override (staff 120/min). Company id is never input (ADR-0013).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { documentViewSchema } from "./document-view.contract.js";

export const DOCUMENT_SHARE_PATH_PREFIX = "/d/";

export const PAGE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function documentShareUrl(
  plaintextToken: string,
  origin: string,
): string {
  return `${origin.replace(/\/$/, "")}${DOCUMENT_SHARE_PATH_PREFIX}${plaintextToken}`;
}

export const shareDocumentInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const shareDocumentOutputSchema = documentViewSchema.extend({
  token: z.string().min(1),
  url: z.url(),
});

export const shareDocumentContract = defineActionContract({
  name: "documents.share",
  description:
    "Rotate the active 90-day page token for a staff document in the active company and return the document view, the plaintext token once, and the public /d/{token} URL. Pre-mints a short-lived PDF download URL when a generated artifact exists; otherwise the token row stores null PDF fields. When a recorded supplier ASiC exists, also pre-mints a short-lived signed download URL beside the unsigned PDF. Re-share remints the token and the signatures. Missing or foreign-company documents fail with not-found. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: shareDocumentInputSchema,
  output: shareDocumentOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 10_000,
});
