/**
 * Golden projection-read contract (SHO-94 / chat-T2). The card stores
 * `orderId` + revision only (ADR-0011); callers fetch order state via
 * `orders.get`.
 *
 * Mechanical: `timeout: 2000` matches `orders.get` — single-row lookup,
 * no nested calls.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const getOrderCardInputSchema = z.object({
  orderId: z.uuid(),
});

export const getOrderCardOutputSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const getOrderCardContract = defineActionContract({
  name: "chat.getOrderCard",
  description:
    "Return the order-card projection for one order in the staff member's active company. The card holds the order id and a revision counter only — never order status or totals. Missing or foreign-company cards fail with not-found.",
  principal: "staff",
  transport: "client",
  input: getOrderCardInputSchema,
  output: getOrderCardOutputSchema,
  permissions: ["chat:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 2_000,
});
