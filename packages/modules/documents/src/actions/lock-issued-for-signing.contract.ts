/**
 * Staff internal lock for `docSigning.start` and `docSigning.complete`
 * (SHO-257 / SHO-258 / feature SHO-251). Copies the `documents.requestSign`
 * / `documents.cancel` header `FOR UPDATE` so start cannot insert a pending
 * `signing_requests` row after cancel commits, and complete cannot record a
 * signature after cancel (nested after ASiC verify, immediately before the
 * unique supplier insert — not held across verify). Re-asserts issued +
 * unexpired HITL grant (TTL 15 minutes) and PDF-ready. Mechanical:
 * `timeout: 5000` matches `documents.requestSign` (nested getArtifact 2000
 * shares the remaining budget). Input is `{ documentId }` only. Company
 * id is never input. Keep off the contract client router.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export { SIGN_REQUEST_GRANT_TTL_MS } from "@showzy/validation/signing";

export const lockIssuedForSigningInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const lockIssuedForSigningOutputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const lockIssuedForSigningContract = defineActionContract({
  name: "documents.lockIssuedForSigning",
  description:
    "Lock the tenant document row and re-assert that it is issued, the HITL signature grant is unexpired, and the PDF is ready. Nested from docSigning.start immediately before inserting a pending signing request and on pending replay before re-issuing the payload URL, and from docSigning.complete after ASiC verify immediately before claiming the unique supplier signature. Cancelled documents fail with conflict. Missing or expired grant and PDF-not-ready fail with validation. Missing or foreign-company documents fail with not-found. Company id is never input. Internal staff lock; not a client route.",
  principal: "staff",
  transport: "internal",
  input: lockIssuedForSigningInputSchema,
  output: lockIssuedForSigningOutputSchema,
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
  timeout: 5_000,
});
