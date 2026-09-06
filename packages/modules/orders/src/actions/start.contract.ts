/**
 * Staff start (SHO-374 / orders-T12). Status-only, copied from
 * `orders.confirm` (ADR-0026): `confirmed` → `in_progress`. No stock, no
 * line edits, no `started_at`. `confirmed_at` is unchanged.
 *
 * Mechanical: `timeout: 5000` matches confirm in this slice.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const startOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const startOrderOutputSchema = z.object({
  orderId: z.uuid(),
  customerId: z.uuid().nullable(),
  status: z.literal("in_progress"),
});

export const startOrderContract = defineActionContract({
  name: "orders.start",
  description:
    "Start a confirmed staff-intake order in the active company. Starting is a status transition only: the order moves from confirmed to in_progress. Already started orders fail with conflict. Missing or foreign-company orders fail with not-found.",
  principal: "staff",
  transport: "client",
  input: startOrderInputSchema,
  output: startOrderOutputSchema,
  permissions: ["orders:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["orders.started"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
