import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { documents, documentShareTokens } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import {
  issueShareDownloadUrl,
  issueShareSigningDownloadUrl,
} from "@showzy/files";
import { holderAuditTarget } from "@showzy/module-kit/audit-target";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import { and, eq, isNull } from "drizzle-orm";

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
import {
  documentPreviewLines,
  hasLiveShareToken,
  loadDocumentPreviewFacts,
} from "../services/preview-document.js";
import { resolveDocumentReference } from "../services/resolve-document-reference.js";
import { getDocumentShareOrigin } from "../services/share-origin.js";
import {
  generateDocumentShareToken,
  hashDocumentShareToken,
} from "../services/token-hash.js";
import { mapShareActiveTokenUniqueViolation } from "../services/unique-violations.js";
import { requireWritable } from "../services/writable.js";

const PAGE_TOKEN_TTL_DAYS = PAGE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000);

function shareNote(replacesActiveLink: boolean): string {
  const lifetime = `воно діє ${String(PAGE_TOKEN_TTL_DAYS)} днів`;
  return replacesActiveLink
    ? `Чинне посилання буде відкликано — працюватиме лише нове, і ${lifetime}.`
    : `Буде створено нове посилання, і ${lifetime}.`;
}

const shareAuditTarget = holderAuditTarget({
  type: "document",
  field: "documentId",
  fallback: "unknown",
  sources: ["output", "resolved", "input"],
});

export const shareDocument = implementAction(shareDocumentContract, {
  handler: async (input, ctx) => {
    const db = requireWritable(ctx.db);
    const documentId = await resolveDocumentReference({
      db,
      companyId: ctx.companyId,
      call: ctx.call,
      input,
    });
    const locked = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          eq(documents.id, documentId),
        ),
      )
      .limit(1)
      .for("update");
    if (locked[0] === undefined) {
      throw new NotFoundError();
    }
    ctx.auditTarget(documentId);

    const view = await loadStaffDocument({
      db: ctx.db,
      companyId: ctx.companyId,
      documentId: documentId,
    });
    const generation = await loadGenerationArtifact({
      documentId: documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    const minted = await mintSharePdfDownload({
      fileId: readyArtifactFileId(generation),
      issueShareDownload: (id) =>
        ctx.call(issueShareDownloadUrl, { fileId: id }),
    });
    const signing = await ctx.call(getSigning, {
      documentId: documentId,
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
          eq(documentShareTokens.documentId, documentId),
          isNull(documentShareTokens.revokedAt),
        ),
      );

    try {
      await db.insert(documentShareTokens).values({
        companyId: ctx.companyId,
        documentId: documentId,
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
  preview: async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, shareDocumentContract);
    const documentId = await resolveDocumentReference({
      db: env.tx,
      companyId,
      call: env.call,
      input,
    });
    const facts = await loadDocumentPreviewFacts({
      tx: env.tx,
      companyId,
      documentId,
    });
    const replacesActiveLink = await hasLiveShareToken({
      tx: env.tx,
      companyId,
      documentId,
    });
    return {
      title: `Поділитися документом ${facts.documentNumber}`,
      lines: documentPreviewLines(facts),
      notes: [shareNote(replacesActiveLink)],
    };
  },
  auditTarget: shareAuditTarget,
});
