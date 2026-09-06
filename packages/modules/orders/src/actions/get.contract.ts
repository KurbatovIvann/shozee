/**
 * Golden write-action contract (SHO-92 / orders-T2). `orders.get` is the
 * staff read of immutable line snapshots; the chat card later stores only
 * `orderId` and fetches here (ADR-0011).
 *
 * Mechanical: `timeout: 2000` — single-row header + lines, no nested calls.
 * Output is the full snapshot. Compact create summaries live on
 * `orders.create`; this action remains the detail read.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { orderViewSchema } from "./order-view.contract.js";

export const getOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const getOrderOutputSchema = orderViewSchema;

export const getOrderContract = defineActionContract({
  name: "orders.get",
  description:
    "Return a staff-intake order and its immutable line snapshots in the active company. Status is one of the CHECK values new, confirmed, in_progress, done, canceled; there is no server status named active or all. Missing or foreign-company orders fail with not-found.",
  principal: "staff",
  transport: "client",
  input: getOrderInputSchema,
  output: getOrderOutputSchema,
  permissions: ["orders:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 2_000,
});
