/**
 * Staff client complete of a pending QES request (SHO-258 / feature SHO-251).
 * Input is `{ requestId, fileId }` only — the client already PUT the ASiC
 * via the signing handshake. Server reads staging, verifies with
 * `@showzy/document-signing` against the frozen payload digest, re-asserts
 * issued + unexpired grant (`documents.lockIssuedForSigning`) after verify
 * and immediately before claiming the unique supplier signature (and
 * `FOR UPDATE`s the pending request), then `ctx.callAtomic(files.recordSigningObject)`.
 * The documents row is not held across verify. A unique Conflict must not
 * have copied S3 yet. Same-file replay does not promote again.
 *
 * Mechanical: `timeout: 30000` is card-named. Nested remaining budgets
 * share one wall-clock deadline (lockIssuedForSigning 5000, readPending
 * 15000, recordSigningObject 15000); the runtime does not sum callee
 * timeouts. `idempotent: true` is required for `ctx.callAtomic`
 * (ADR-0021). `requiresConfirmation: false` — HITL already ran on
 * requestSign. Company id is never input. Do not raise the oRPC body
 * limit; there is no base64 field.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const COMPLETE_SIGNING_TIMEOUT_MS = 30_000;

export const completeSigningInputSchema = z.strictObject({
  requestId: z.uuid(),
  fileId: z.uuid(),
});

export const completeSigningOutputSchema = z.strictObject({
  documentId: z.uuid(),
  requestId: z.uuid(),
  fileId: z.uuid(),
  signerRole: z.literal("supplier"),
  signerCn: z.string().min(1),
  signerOrg: z.string(),
  signerTaxId: z.string(),
  signatureAlg: z.string().min(1),
  signedAt: z.iso.datetime(),
});

export const completeSigningContract = defineActionContract({
  name: "docSigning.complete",
  description:
    "Verify a handshake-PUT ASiC-E against the frozen payload digest of a pending staff signing request, claim the unique supplier signature, record the durable signing object, and store the redacted supplier certificate. Replay of the same successful file returns the same view without a second promote. A second supplier signature on the document fails with conflict. Cancelled documents, expired grants, invalid ASiC, digest mismatch, oversize objects, and foreign file or request ids fail as specified. Company id is never input. Confirmation already ran on documents.requestSign.",
  principal: "staff",
  transport: "client",
  input: completeSigningInputSchema,
  output: completeSigningOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["docSigning.recorded"],
  atomicCalls: ["files.recordSigningObject"],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: COMPLETE_SIGNING_TIMEOUT_MS,
});
