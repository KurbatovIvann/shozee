import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  DOCUMENT_REFERENCE_DESCRIPTION,
  documentReferenceInputSchema,
} from "./document-reference.contract.js";

export const requestSignInputSchema = documentReferenceInputSchema;

export const requestSignOutputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const requestSignContract = defineActionContract({
  name: "documents.requestSign",
  description: `Request a qualified electronic signature for an issued staff document whose PDF is ready. Sets the HITL grant timestamp (TTL 15 minutes, enforced on start). Cancelled, already supplier-signed, or PDF-not-ready documents fail. Missing or foreign-company documents fail with not-found. Company id is never input. Requires confirmation. Confirmation does not replace key possession. Re-submitting the identical payload with the same idempotency key after success returns the stored acknowledgement. ${DOCUMENT_REFERENCE_DESCRIPTION}`,
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
