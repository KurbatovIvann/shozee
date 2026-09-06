/**
 * Golden projection-write contract (SHO-94 / chat-T2). Bound to both
 * `orders.created` and `orders.confirmed` under consumer
 * `chat.order-card-updater`. Idempotency is the delivery row, not
 * `idempotency_keys`.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other system consumers (kit / orders test-local).
 * - Envelope shape is duplicated here with Zod because `*.contract.ts` may
 *   not import `eventEnvelopeSchema` from the core runtime. Payload is
 *   `{ orderId }` only so extras (totals, confirmedAt) are stripped
 *   (ADR-0011).
 * - `name` is the two consumed events so a random envelope fails validation.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const ORDER_CARD_EVENT_NAMES = [
  "orders.created",
  "orders.confirmed",
] as const;

export const upsertOrderCardPayloadSchema = z.object({
  orderId: z.uuid(),
});

export const upsertOrderCardInputSchema = z.object({
  eventId: z.uuid(),
  name: z.enum(ORDER_CARD_EVENT_NAMES),
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
  payload: upsertOrderCardPayloadSchema,
});

export const upsertOrderCardOutputSchema = z.object({
  orderCardId: z.uuid(),
  revision: z.number().int().positive(),
  applied: z.literal(true),
});

export const upsertOrderCardContract = defineActionContract({
  name: "chat.upsertOrderCard",
  description:
    "Insert or bump the order-card projection for a tenant-scoped orders.created or orders.confirmed delivery. Uses the order id only: insert revision 1 when the card is absent (including when confirm arrives first), otherwise increment revision. Missing or foreign-company orders fail with not-found.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: upsertOrderCardInputSchema,
  output: upsertOrderCardOutputSchema,
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
  timeout: 5_000,
});
