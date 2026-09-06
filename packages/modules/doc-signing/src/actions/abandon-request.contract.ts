/**
 * System write bound to `documents.cancelled` (SHO-254 / feature SHO-251).
 * Copy `chat.upsertOrderCard`. Envelope Zod is duplicated because
 * `*.contract.ts` may not import `eventEnvelopeSchema` from the core
 * runtime. Idempotency is the delivery row, not `idempotency_keys`.
 *
 * Mechanical: `timeout: 10000` covers nested `documents.getForGeneration`
 * (5000) plus the pending-request delete. Tenant scope comes from the
 * system delivery context, never from input as a grant.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const ABANDON_REQUEST_EVENT_NAME = "documents.cancelled" as const;

export const abandonRequestPayloadSchema = z.object({
  documentId: z.uuid(),
  orderId: z.uuid(),
});

export const abandonRequestInputSchema = z.object({
  eventId: z.uuid(),
  name: z.literal(ABANDON_REQUEST_EVENT_NAME),
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
  payload: abandonRequestPayloadSchema,
});

export const abandonRequestOutputSchema = z.object({
  documentId: z.uuid(),
});

export const abandonRequestContract = defineActionContract({
  name: "docSigning.abandonRequest",
  description:
    "Drop the live pending signing request for a delivered documents.cancelled envelope document. Completed supplier signatures are not deleted. Tenant scope comes from the system delivery context, never from input as a grant. Missing or foreign-company documents fail with not-found. Retry-safe: a second delivery is a no-op delete.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: abandonRequestInputSchema,
  output: abandonRequestOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: true,
  timeout: 10_000,
});
