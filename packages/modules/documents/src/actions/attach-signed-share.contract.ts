/**
 * System write bound to `docSigning.recorded` (SHO-259 / feature SHO-251).
 * Copy `docGeneration.renderPdf` / `chat.upsertOrderCard`. Envelope Zod is
 * duplicated because `*.contract.ts` may not import `eventEnvelopeSchema`
 * from the core runtime.
 *
 * Mechanical: `timeout: 10000` covers nested
 * `files.issueSystemSigningDownloadUrl` (5000) plus the active-token
 * update. Tenant scope comes from the system delivery context, never
 * from input as a grant. Idempotency is the delivery row, not
 * `idempotency_keys`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const ATTACH_SIGNED_SHARE_EVENT_NAME = "docSigning.recorded" as const;

export const attachSignedSharePayloadSchema = z.object({
  documentId: z.uuid(),
  signerRole: z.literal("supplier"),
  fileId: z.uuid(),
});

export const attachSignedShareInputSchema = z.object({
  eventId: z.uuid(),
  name: z.literal(ATTACH_SIGNED_SHARE_EVENT_NAME),
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
  payload: attachSignedSharePayloadSchema,
});

export const attachSignedShareOutputSchema = z.object({
  documentId: z.uuid(),
});

export const attachSignedShareContract = defineActionContract({
  name: "documents.attachSignedShare",
  description:
    "Write a short-lived signed ASiC download URL onto the active unrevoked page token for a delivered docSigning.recorded envelope document. Does not rotate or revoke the page token. Missing or foreign-company documents fail with not-found. No active token is a no-op so a later staff Share can mint both URLs. Tenant scope comes from the system delivery context, never from input as a grant. Retry-safe: a second delivery remints the signature on the same token hash.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: attachSignedShareInputSchema,
  output: attachSignedShareOutputSchema,
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
  timeout: 10_000,
});
