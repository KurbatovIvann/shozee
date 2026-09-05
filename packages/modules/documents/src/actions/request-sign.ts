import { implementAction, type AuditTargetEnv } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
} from "@showzy/validation/signing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { documentsSignRequested } from "../events/sign-requested.js";
import {
  loadGenerationArtifact,
  readyArtifactFileId,
} from "../services/load-generation.js";
import { requireReadyPdf } from "../services/signing-gates.js";
import { requireWritable } from "../services/writable.js";
import { requestSignContract } from "./request-sign.contract.js";

export {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
};

/**
 * Staff confirmationSummary cannot load the document (core.md §7
 * `ConfirmationSummaryEnv` is validated input + company id; no handler
 * `ctx` / tx). Live number would also distinguish missing vs foreign ids
 * on the challenge. The UI already has the document from list/get when it
 * shows the dialog. Confirmation does not replace key possession.
 */
export const requestSignConfirmationSummary =
  "Request a qualified electronic signature for this issued document. Confirm the number and type shown in the dialog. You still need the signing key on the device — confirmation does not replace key possession.";

const documentIdHolder = z.object({ documentId: z.string() });

function requestSignAuditTarget(env: AuditTargetEnv): {
  type: string;
  id: string;
} {
  const parsed = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: parsed.success ? parsed.data.documentId : "unknown",
  };
}

export const requestSign = implementAction(requestSignContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const rows = await db
      .select({
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
      throw new ConflictError(CANCELLED_REQUEST_SIGN_MESSAGE);
    }
    if (row.status !== "issued") {
      throw new ConflictError(CANCELLED_REQUEST_SIGN_MESSAGE);
    }

    const generation = await loadGenerationArtifact({
      documentId: input.documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    requireReadyPdf(readyArtifactFileId(generation));

    const signing = await ctx.call(getSigning, {
      documentId: input.documentId,
    });
    if (signing.status === "supplier_signed") {
      throw new ConflictError(ALREADY_SIGNED_MESSAGE);
    }

    const updated = await db
      .update(documents)
      .set({ signRequestedAt: new Date() })
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, input.documentId),
        ),
      )
      .returning({ id: documents.id });
    if (updated[0] === undefined) {
      throw new CoreInvariantError(
        "documents.requestSign update returned no row",
      );
    }

    ctx.emit(documentsSignRequested, {
      aggregate: { type: "document", id: input.documentId },
      payload: { documentId: input.documentId },
    });

    return { documentId: input.documentId };
  },
  confirmationSummary: () => requestSignConfirmationSummary,
  auditTarget: requestSignAuditTarget,
});
