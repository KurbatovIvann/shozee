import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { documents, documentShareTokens } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import {
  issueShareDownloadUrl,
  issueShareSigningDownloadUrl,
} from "@showzy/files";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  PAGE_TOKEN_TTL_MS,
  documentShareUrl,
  shareDocumentContract,
} from "./share.contract.js";
import { loadStaffDocument } from "../services/load-document.js";
import {
  loadGenerationArtifact,
  readyArtifactFileId,
} from "../services/load-generation.js";
import {
  mintShareDownload,
  mintSharePdfDownload,
} from "../services/mint-share-pdf.js";
import { getDocumentShareOrigin } from "../services/share-origin.js";
import {
  generateDocumentShareToken,
  hashDocumentShareToken,
} from "../services/token-hash.js";
import { mapShareActiveTokenUniqueViolation } from "../services/unique-violations.js";
import { requireWritable } from "../services/writable.js";

const documentIdHolder = z.object({ documentId: z.string() });

function shareAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const parsed = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: parsed.success ? parsed.data.documentId : "unknown",
  };
}

export const shareDocument = implementAction(shareDocumentContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const locked = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, input.documentId),
        ),
      )
      .limit(1)
      .for("update");
    if (locked[0] === undefined) {
      throw new NotFoundError();
    }

    const view = await loadStaffDocument({
      db: ctx.db,
      companyId: ctx.companyId,
      documentId: input.documentId,
    });
    const generation = await loadGenerationArtifact({
      documentId: input.documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    const minted = await mintSharePdfDownload({
      fileId: readyArtifactFileId(generation),
      issueShareDownload: (id) =>
        ctx.call(issueShareDownloadUrl, { fileId: id }),
    });
    const signing = await ctx.call(getSigning, {
      documentId: input.documentId,
    });
    const signedFileId =
      signing.status === "supplier_signed"
        ? (signing.signedFileId ?? null)
        : null;
    const mintedSigned = await mintShareDownload({
      fileId: signedFileId,
      issueShareDownload: (id) =>
        ctx.call(issueShareSigningDownloadUrl, { fileId: id }),
    });
    const now = new Date();
    const plaintextToken = generateDocumentShareToken();
    const tokenHash = hashDocumentShareToken(plaintextToken);

    await db
      .update(documentShareTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(documentShareTokens.companyId, ctx.companyId),
          eq(documentShareTokens.documentId, input.documentId),
          isNull(documentShareTokens.revokedAt),
        ),
      );

    try {
      await db.insert(documentShareTokens).values({
        companyId: ctx.companyId,
        documentId: input.documentId,
        tokenHash,
        expiresAt: new Date(now.getTime() + PAGE_TOKEN_TTL_MS),
        pdfDownloadUrl: minted.pdfDownloadUrl,
        pdfDownloadExpiresAt: minted.pdfDownloadExpiresAt,
        signedDownloadUrl: mintedSigned.downloadUrl,
        signedDownloadExpiresAt: mintedSigned.downloadExpiresAt,
        createdAt: now,
      });
    } catch (error) {
      throw mapShareActiveTokenUniqueViolation(error);
    }

    return {
      ...view,
      token: plaintextToken,
      url: documentShareUrl(plaintextToken, getDocumentShareOrigin()),
    };
  },
  auditTarget: shareAuditTarget,
});
