/**
 * Golden write-action contract (SHO-92 / orders-T2). Confirm is status-only
 * (ADR-0026): `new` → `confirmed` + `confirmed_at`. No stock decrement and
 * no `ctx.call` / `atomicCalls` until catalog owns inventory columns.
 *
 * Mechanical: `timeout: 5000` matches other staff writes in this slice.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const confirmOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const confirmOrderOutputSchema = z.object({
  orderId: z.uuid(),
  customerId: z.uuid().nullable(),
  status: z.literal("confirmed"),
  confirmedAt: z.iso.datetime(),
});

export const confirmOrderContract = defineActionContract({
  name: "orders.confirm",
  description:
    "Confirm a new staff-intake order in the active company. Confirmation is a status transition only: the order moves from new to confirmed and records confirmed_at. Already confirmed or canceled orders fail with conflict. Missing or foreign-company orders fail with not-found.",
  principal: "staff",
  transport: "client",
  input: confirmOrderInputSchema,
  output: confirmOrderOutputSchema,
  permissions: ["orders:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["orders.confirmed"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
