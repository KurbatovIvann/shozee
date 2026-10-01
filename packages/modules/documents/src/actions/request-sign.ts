import { implementAction, type AuditTargetEnv } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
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
import {
  documentPreviewLines,
  loadDocumentPreviewFacts,
} from "../services/preview-document.js";
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
  return `Запросити підписання документа ${documentNumber}. ${REQUEST_SIGN_KEY_POSSESSION_NOTE}`;
}

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
  preview: async (input, env) => {
    const facts = await loadDocumentPreviewFacts({
      tx: env.tx,
      companyId: previewCompanyScope(env.companyId, requestSignContract),
      documentId: input.documentId,
    });
    return {
      title: requestSignPreviewTitle(facts.documentNumber),
      lines: documentPreviewLines(facts),
    };
  },
  auditTarget: requestSignAuditTarget,
});
