import { implementAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { orders } from "@showzy/db/schema/orders";
import { holderAuditTarget } from "@showzy/module-kit/audit-target";
import { and, eq } from "drizzle-orm";

import { ordersStarted } from "../events/started.js";
import { orderTransitionPreview } from "../services/preview-card.js";
import { resolveOrderReference } from "../services/resolve-order-reference.js";
import { requireWritable } from "../services/writable.js";
import { startOrderContract } from "./start.contract.js";

const startAuditTarget = holderAuditTarget({
  type: "order",
  field: "orderId",
  fallback: "unknown",
  sources: ["output", "resolved", "input"],
});

export const startOrder = implementAction(startOrderContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const orderId = await resolveOrderReference({
      db,
      companyId: ctx.companyId,
      call: ctx.call,
      input,
    });
    const rows = await db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(eq(orders.companyId, ctx.companyId), eq(orders.id, orderId)))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    ctx.auditTarget(orderId);
    if (row.status === "in_progress") {
      throw new ConflictError("Order is already started.");
    }
    if (row.status !== "confirmed") {
      throw new ConflictError("Order cannot be started.");
    }

    const updated = await db
      .update(orders)
      .set({ status: "in_progress" })
      .where(and(eq(orders.companyId, ctx.companyId), eq(orders.id, orderId)))
      .returning({
        customerId: orders.customerId,
      });
    const saved = updated[0];
    if (saved === undefined) {
      throw new CoreInvariantError("orders.start update returned no row");
    }

    ctx.emit(ordersStarted, {
      aggregate: { type: "order", id: orderId },
      payload: {
        orderId: orderId,
        customerId: saved.customerId,
      },
    });

    return {
      orderId: orderId,
      customerId: saved.customerId,
      status: "in_progress" as const,
    };
  },
  preview: orderTransitionPreview(
    startOrderContract,
    "Взяти в роботу замовлення",
  ),
  auditTarget: startAuditTarget,
});
