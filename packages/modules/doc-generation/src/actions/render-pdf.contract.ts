/**
 * System write bound to `documents.created` (SHO-236 / feature SHO-227).
 * Copy `chat.upsertOrderCard`. Envelope Zod is duplicated because
 * `*.contract.ts` may not import `eventEnvelopeSchema` from the core
 * runtime.
 *
 * Mechanical: the action name is `docGeneration.renderPdf` (camelCase
 * module segment). Core `ACTION_NAME_PATTERN` rejects a hyphen in
 * `<module>.<verb>`; the package and schema stay `@showzy/doc-generation`.
 * `timeout: 30000` covers TSX render, S3 PUT of up to 25 MiB, nested
 * `documents.getForGeneration` (5000), and `ctx.callAtomic`
 * `files.recordGeneratedObject` (15000). Recording the PDF is the named
 * files composition (ADR-0021); the parent card's "no ctx.callAtomic"
 * applied to `documents.createFromOrder`, not this edge.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  generationJobStatusSchema,
  getArtifactOutputSchema,
} from "./get-artifact.contract.js";

export const RENDER_PDF_EVENT_NAME = "documents.created" as const;

export const renderPdfPayloadSchema = z.object({
  documentId: z.uuid(),
  orderId: z.uuid(),
  type: z.enum(["payment_invoice", "delivery_note"]),
  documentNumber: z.string().min(1),
});

export const renderPdfInputSchema = z.object({
  eventId: z.uuid(),
  name: z.literal(RENDER_PDF_EVENT_NAME),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  companyId: z.uuid().nullable(),
  aggregate: z.object({
    type: z.string().min(1),
    id: z.uuid(),
    sequence: z.string().regex(/^[0-9]+$/),
  }),
  actor: z.object({
    type: z.enum(["user", "system"]),
    id: z.string().min(1),
    channel: z.enum(["ui", "ai", "system", "webhook"]),
  }),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1),
  payload: renderPdfPayloadSchema,
});

export const renderPdfOutputSchema = getArtifactOutputSchema.extend({
  documentId: z.uuid(),
  status: generationJobStatusSchema,
});

export const renderPdfContract = defineActionContract({
  name: "docGeneration.renderPdf",
  description:
    "Render the system TSX invoice or delivery-note PDF for a delivered documents.created event, PUT the bytes, and record a purpose=document file. Upserts one generation job per document (pending → ready). Tenant scope comes from the system delivery context, never from input as a grant. Retry-safe: a ready job returns the same artifact file id. Transient renderer/storage failures throw so outbox delivery retries (five attempts, 1s/2s/4s/8s); terminal snapshot invariants persist failed and return. Exhausted retries are finalized by docGeneration.markFailed outside this transaction. Missing and foreign-company documents stay NotFound (not CONFLICT) so isolation is not weakened; those deliveries are not failure-bookkept.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: renderPdfInputSchema,
  output: renderPdfOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: ["files.recordGeneratedObject"],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 30_000,
});
