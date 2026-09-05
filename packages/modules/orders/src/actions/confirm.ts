import { implementAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { orders } from "@showzy/db/schema/orders";
import { holderAuditTarget } from "@showzy/module-kit/audit-target";
import { and, eq } from "drizzle-orm";

import { ordersConfirmed } from "../events/confirmed.js";
import { requireWritable } from "../services/writable.js";
import { confirmOrderContract } from "./confirm.contract.js";

const confirmAuditTarget = holderAuditTarget({
  type: "order",
  field: "orderId",
  fallback: "unknown",
  sources: ["input"],
});

export const confirmOrder = implementAction(confirmOrderContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const rows = await db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(
        and(eq(orders.companyId, ctx.companyId), eq(orders.id, input.orderId)),
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    if (row.status === "confirmed") {
      throw new ConflictError("Order is already confirmed.");
    }
    if (row.status !== "new") {
      throw new ConflictError("Order cannot be confirmed.");
    }

    const confirmedAt = new Date();
    const updated = await db
      .update(orders)
      .set({ status: "confirmed", confirmedAt })
      .where(
        and(eq(orders.companyId, ctx.companyId), eq(orders.id, input.orderId)),
      )
      .returning({
        confirmedAt: orders.confirmedAt,
        customerId: orders.customerId,
      });
    const saved = updated[0];
    if (saved === undefined || saved.confirmedAt === null) {
      throw new CoreInvariantError(
        "orders.confirm update returned no confirmed_at",
      );
    }

    const confirmedAtIso = saved.confirmedAt.toISOString();
    ctx.emit(ordersConfirmed, {
      aggregate: { type: "order", id: input.orderId },
      payload: {
        orderId: input.orderId,
        customerId: saved.customerId,
        confirmedAt: confirmedAtIso,
      },
    });

    return {
      orderId: input.orderId,
      customerId: saved.customerId,
      status: "confirmed" as const,
      confirmedAt: confirmedAtIso,
    };
  },
  auditTarget: confirmAuditTarget,
});
