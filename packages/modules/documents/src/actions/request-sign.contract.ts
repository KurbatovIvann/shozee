/**
 * Staff HITL grant for QES signing (SHO-256 / feature SHO-251). Copy
 * `customers.deleteCustomer` / `pricing.deletePriceList`: high risk,
 * confirmation, static summary (no live number, no PII). Confirmation
 * does not replace key possession (core.md §7.3). Do not name this
 * `documents.sign`.
 *
 * Mechanical: `timeout: 5000` is card-named. Nested `docGeneration.getArtifact`
 * (2000) and `docSigning.get` (5000) share the remaining budget. Input is
 * `{ documentId }` only. Company id is never input. Output is `{ documentId }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const requestSignInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const requestSignOutputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const requestSignContract = defineActionContract({
  name: "documents.requestSign",
  description:
    "Request a qualified electronic signature for an issued staff document whose PDF is ready. Sets the HITL grant timestamp (TTL 15 minutes, enforced on start). Cancelled, already supplier-signed, or PDF-not-ready documents fail. Missing or foreign-company documents fail with not-found. Company id is never input. Requires confirmation. Confirmation does not replace key possession. Re-submitting the identical payload with the same idempotency key after success returns the stored acknowledgement.",
  principal: "staff",
  transport: "client",
  input: requestSignInputSchema,
  output: requestSignOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "exposed",
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  emits: ["documents.signRequested"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
