import { implementAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { orders } from "@showzy/db/schema/orders";
import { holderAuditTarget } from "@showzy/module-kit/audit-target";
import { and, eq } from "drizzle-orm";

import { ordersCompleted } from "../events/completed.js";
import { orderTransitionPreview } from "../services/preview-card.js";
import { resolveOrderReference } from "../services/resolve-order-reference.js";
import { requireWritable } from "../services/writable.js";
import { completeOrderContract } from "./complete.contract.js";

const completeAuditTarget = holderAuditTarget({
  type: "order",
  field: "orderId",
  fallback: "unknown",
  sources: ["output", "resolved", "input"],
});

export const completeOrder = implementAction(completeOrderContract, {
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
    if (row.status === "done") {
      throw new ConflictError("Order is already completed.");
    }
    if (row.status !== "in_progress") {
      throw new ConflictError("Order cannot be completed.");
    }

    const updated = await db
      .update(orders)
      .set({ status: "done" })
      .where(and(eq(orders.companyId, ctx.companyId), eq(orders.id, orderId)))
      .returning({
        customerId: orders.customerId,
      });
    const saved = updated[0];
    if (saved === undefined) {
      throw new CoreInvariantError("orders.complete update returned no row");
    }

    ctx.emit(ordersCompleted, {
      aggregate: { type: "order", id: orderId },
      payload: {
        orderId: orderId,
        customerId: saved.customerId,
      },
    });

    return {
      orderId: orderId,
      customerId: saved.customerId,
      status: "done" as const,
    };
  },
  preview: orderTransitionPreview(
    completeOrderContract,
    "Завершити замовлення",
  ),
  auditTarget: completeAuditTarget,
});
