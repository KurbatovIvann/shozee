/**
 * Staff client start of a pending QES request (SHO-257 / feature SHO-251).
 * Requires an unexpired `documents.requestSign` HITL grant (TTL 15
 * minutes). Confirmation on requestSign does not replace this check and
 * does not replace key possession. Nested reads:
 * `documents.lockIssuedForSigning` (issued + grant + PDF authority),
 * `docGeneration.getArtifact` (payload `fileId` without a discarded URL),
 * and `files.issueDocumentDownloadUrl`. Pending replay issues the URL for
 * the stored `payloadFileId`. Already-supplier-signed is a local
 * `signing_signatures` query.
 *
 * Ticket "idempotent" is domain replay of the live pending row (same
 * requestId + frozen digest, fresh URL). Metadata `idempotent: false`
 * so the protocol cache cannot freeze the short-lived URL.
 *
 * Mechanical: `timeout: 30000` is greater than the sequential remaining
 * callee budgets lockIssuedForSigning (5000, nested getArtifact 2000) +
 * getArtifact (2000) + issueDocumentDownloadUrl (5000). Input is
 * `{ documentId }` only. Company id is never input. `emits: []` — the
 * card did not name an event. `requiresConfirmation: false` — HITL
 * already ran on requestSign.
 */
import { defineActionContract } from "@showzy/core/contract";
import { SIGN_REQUEST_TTL_MS } from "@showzy/validation/signing";
import { z } from "zod";

export { SIGN_REQUEST_TTL_MS };

export const START_SIGNING_TIMEOUT_MS = 30_000;

export const payloadSha256Schema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "Expected a 64-character lowercase hex SHA-256 digest",
  );

export const startSigningInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const startSigningOutputSchema = z.strictObject({
  requestId: z.uuid(),
  documentId: z.uuid(),
  payloadFileId: z.uuid(),
  payloadSha256: payloadSha256Schema,
  payloadDigestAlgorithm: z.literal("sha256"),
  payloadDownloadUrl: z.url(),
  payloadDownloadExpiresAt: z.iso.datetime(),
});

export const startSigningContract = defineActionContract({
  name: "docSigning.start",
  description:
    "Start a pending qualified-signature request for an issued staff document whose HITL grant is unexpired and whose PDF is ready. Freezes the payload SHA-256 digest and returns a short-lived payload download URL. Replay of a live pending row returns the same request id and frozen digest with a newly issued URL. Cancelled or already supplier-signed documents fail with conflict. Missing grant, expired grant, or PDF-not-ready fail with validation. Missing or foreign-company documents fail with not-found. Company id is never input. Confirmation already ran on documents.requestSign and does not replace this grant check or key possession.",
  principal: "staff",
  transport: "client",
  input: startSigningInputSchema,
  output: startSigningOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: START_SIGNING_TIMEOUT_MS,
});
