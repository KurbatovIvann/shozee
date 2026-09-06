/**
 * Internal system-tenant finalizer for a terminal PDF job (SHO-436).
 * Commits failed domain state in its own action transaction so a thrown
 * retry from `docGeneration.renderPdf` cannot roll the mark back.
 * Not a client or AI tool. Company id is never input.
 *
 * Mechanical: `timeout: 5000` matches other system consumers
 * (`chat.upsertOrderCard`). Idempotent: replay of the same document
 * returns the durable row (ready wins over a stale failure).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const markFailedInputSchema = z.strictObject({
  documentId: z.uuid(),
});

export const markFailedOutputSchema = z.object({
  status: z.enum(["ready", "failed"]),
  fileId: z.uuid().nullable(),
  documentId: z.uuid(),
});

export const markFailedContract = defineActionContract({
  name: "docGeneration.markFailed",
  description:
    "Persist a durable failed generation job for a tenant document after outbox retries are exhausted. Tenant scope comes from the system delivery context, never from input as a grant. A concurrent ready artifact is left unchanged. Missing and foreign-company documents fail with not-found. Internal; not a client or AI route.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: markFailedInputSchema,
  output: markFailedOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
