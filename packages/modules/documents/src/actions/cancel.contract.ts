/**
 * Staff cancel (SHO-234 / feature SHO-227). Copy `orders.cancel`:
 * `issued` → `cancelled` only. Already cancelled → conflict. The document
 * number stays consumed (do not rewind `document_number_counters`).
 *
 * Mechanical: `timeout: 10000` covers nested `docSigning.get` (5000) plus
 * the status write. Output is status-only (documentId, orderId, status)
 * like orders.cancel — not the get view. Input is a strict object so
 * `companyId` cannot be smuggled in (ADR-0013; documents create/list/get
 * already do this).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const cancelDocumentInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const cancelDocumentOutputSchema = z.object({
  documentId: z.uuid(),
  orderId: z.uuid(),
  status: z.literal("cancelled"),
});

export const cancelDocumentContract = defineActionContract({
  name: "documents.cancel",
  description:
    "Cancel an issued staff document in the active company. Cancellation is a status transition only: issued moves to cancelled. The document number stays consumed. A recorded supplier signature fails with conflict. Already cancelled documents fail with conflict. Unsigned cancel clears the HITL grant. Missing or foreign-company documents fail with not-found. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: cancelDocumentInputSchema,
  output: cancelDocumentOutputSchema,
  permissions: ["documents:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["documents.cancelled"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 10_000,
});
