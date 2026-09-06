/**
 * Staff complete (SHO-374 / orders-T12). Status-only, copied from
 * `orders.confirm` (ADR-0026): `in_progress` → `done`. No stock, no line
 * edits, no `completed_at`. `confirmed_at` is unchanged. The event name is
 * `orders.completed`; the status value stays `done`.
 *
 * Mechanical: `timeout: 5000` matches confirm in this slice.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const completeOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const completeOrderOutputSchema = z.object({
  orderId: z.uuid(),
  customerId: z.uuid().nullable(),
  status: z.literal("done"),
});

export const completeOrderContract = defineActionContract({
  name: "orders.complete",
  description:
    "Complete an in-progress staff-intake order in the active company. Completion is a status transition only: the order moves from in_progress to done. Already completed orders fail with conflict. Missing or foreign-company orders fail with not-found.",
  principal: "staff",
  transport: "client",
  input: completeOrderInputSchema,
  output: completeOrderOutputSchema,
  permissions: ["orders:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["orders.completed"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
