import { implementAction, type AuditTargetEnv } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getSigning } from "@showzy/doc-signing/get";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { documentsCancelled } from "../events/cancelled.js";
import { requireWritable } from "../services/writable.js";
import { cancelDocumentContract } from "./cancel.contract.js";

export const ALREADY_CANCELLED_MESSAGE = "Document is already cancelled.";
export const CANNOT_CANCEL_MESSAGE = "Document cannot be cancelled.";
export const SIGNED_CANNOT_CANCEL_MESSAGE =
  "A signed document cannot be cancelled.";

const documentIdHolder = z.object({ documentId: z.string() });

function cancelAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const parsed = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: parsed.success ? parsed.data.documentId : "unknown",
  };
}

export const cancelDocument = implementAction(cancelDocumentContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    // Header lock copies `orders.cancel`. `loadStaffDocument` is the T3
    // get assembler (full view + line snapshots, no FOR UPDATE) — not a
    // second cancel loader.
    const rows = await db
      .select({
        orderId: documents.orderId,
        status: documents.status,
      })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, input.documentId),
        ),
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    if (row.status === "cancelled") {
      throw new ConflictError(ALREADY_CANCELLED_MESSAGE);
    }
    if (row.status !== "issued") {
      throw new ConflictError(CANNOT_CANCEL_MESSAGE);
    }

    const signing = await ctx.call(getSigning, {
      documentId: input.documentId,
    });
    if (signing.status === "supplier_signed") {
      throw new ConflictError(SIGNED_CANNOT_CANCEL_MESSAGE);
    }

    const updated = await db
      .update(documents)
      .set({ status: "cancelled", signRequestedAt: null })
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, input.documentId),
        ),
      )
      .returning({
        orderId: documents.orderId,
      });
    const saved = updated[0];
    if (saved === undefined) {
      throw new CoreInvariantError("documents.cancel update returned no row");
    }

    ctx.emit(documentsCancelled, {
      aggregate: { type: "document", id: input.documentId },
      payload: {
        documentId: input.documentId,
        orderId: saved.orderId,
      },
    });

    return {
      documentId: input.documentId,
      orderId: saved.orderId,
      status: "cancelled" as const,
    };
  },
  auditTarget: cancelAuditTarget,
});
