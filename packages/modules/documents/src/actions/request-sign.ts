import { implementAction } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import { holderAuditTarget } from "@showzy/module-kit/audit-target";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
} from "@showzy/validation/signing";
import { and, eq } from "drizzle-orm";

import { documentsSignRequested } from "../events/sign-requested.js";
import {
  loadGenerationArtifact,
  readyArtifactFileId,
} from "../services/load-generation.js";
import {
  documentPreviewLines,
  loadDocumentPreviewFacts,
} from "../services/preview-document.js";
import { resolveDocumentReference } from "../services/resolve-document-reference.js";
import { requireReadyPdf } from "../services/signing-gates.js";
import { requireWritable } from "../services/writable.js";
import { requestSignContract } from "./request-sign.contract.js";

export {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
};

export const REQUEST_SIGN_KEY_POSSESSION_NOTE =
  "Підтвердження не замінює володіння ключем — документ підписують на вашому пристрої.";

export function requestSignPreviewTitle(documentNumber: string): string {
  return `Запросити підписання документа ${documentNumber}`;
}

const requestSignAuditTarget = holderAuditTarget({
  type: "document",
  field: "documentId",
  fallback: "unknown",
  sources: ["output", "input"],
});

export const requestSign = implementAction(requestSignContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const documentId = await resolveDocumentReference({
      db,
      companyId: ctx.companyId,
      call: ctx.call,
      input,
    });
    const rows = await db
      .select({
        status: documents.status,
      })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, documentId),
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
      documentId: documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    requireReadyPdf(readyArtifactFileId(generation));

    const signing = await ctx.call(getSigning, {
      documentId: documentId,
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
          eq(documents.id, documentId),
        ),
      )
      .returning({ id: documents.id });
    if (updated[0] === undefined) {
      throw new CoreInvariantError(
        "documents.requestSign update returned no row",
      );
    }

    ctx.emit(documentsSignRequested, {
      aggregate: { type: "document", id: documentId },
      payload: { documentId: documentId },
    });

    return { documentId: documentId };
  },
  preview: async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, requestSignContract);
    const facts = await loadDocumentPreviewFacts({
      tx: env.tx,
      companyId,
      documentId: await resolveDocumentReference({
        db: env.tx,
        companyId,
        call: env.call,
        input,
      }),
    });
    return {
      title: requestSignPreviewTitle(facts.documentNumber),
      lines: documentPreviewLines(facts),
      notes: [REQUEST_SIGN_KEY_POSSESSION_NOTE],
    };
  },
  auditTarget: requestSignAuditTarget,
});
