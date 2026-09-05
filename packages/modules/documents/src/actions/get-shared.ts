import {
  implementAction,
  type ResolvedTarget,
  type TargetResolutionEnv,
} from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { documentShareTokens } from "@showzy/db/schema/documents";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getSharedContract } from "./get-shared.contract.js";
import { loadStaffDocument } from "../services/load-document.js";
import {
  storedShareDownloadUrl,
  storedSharePdfDownloadUrl,
} from "../services/share-pdf-url.js";
import { hashDocumentShareToken } from "../services/token-hash.js";

export const sharedTokenResourceSchema = z.object({
  documentId: z.string().min(1),
  pdfDownloadUrl: z.string().nullable(),
  pdfDownloadExpiresAt: z.date().nullable(),
  signedDownloadUrl: z.string().nullable(),
  signedDownloadExpiresAt: z.date().nullable(),
});

export type SharedTokenResource = z.output<typeof sharedTokenResourceSchema>;

async function resolveSharedDocument(
  input: { token: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<SharedTokenResource>> {
  if (env.principal.mode !== "public") {
    throw new NotFoundError();
  }
  const tokenHash = hashDocumentShareToken(input.token);
  const rows = await env.tx
    .select({
      companyId: documentShareTokens.companyId,
      documentId: documentShareTokens.documentId,
      expiresAt: documentShareTokens.expiresAt,
      revokedAt: documentShareTokens.revokedAt,
      pdfDownloadUrl: documentShareTokens.pdfDownloadUrl,
      pdfDownloadExpiresAt: documentShareTokens.pdfDownloadExpiresAt,
      signedDownloadUrl: documentShareTokens.signedDownloadUrl,
      signedDownloadExpiresAt: documentShareTokens.signedDownloadExpiresAt,
    })
    .from(documentShareTokens)
    .where(eq(documentShareTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  const nowMs = Date.now();
  if (
    row === undefined ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= nowMs
  ) {
    throw new NotFoundError();
  }
  return {
    companyId: row.companyId,
    resource: {
      documentId: row.documentId,
      pdfDownloadUrl: row.pdfDownloadUrl,
      pdfDownloadExpiresAt: row.pdfDownloadExpiresAt,
      signedDownloadUrl: row.signedDownloadUrl,
      signedDownloadExpiresAt: row.signedDownloadExpiresAt,
    },
  };
}

export const getShared = implementAction(getSharedContract, {
  resolveTarget: resolveSharedDocument,
  handler: async (_input, ctx) => {
    if (ctx.scope !== "target") {
      throw new CoreInvariantError("documents.getShared expects public-target");
    }
    const resource = parseDbEnum(
      sharedTokenResourceSchema,
      ctx.target.resource,
      "documents.getShared resolver must return a share-token resource",
    );
    const view = await loadStaffDocument({
      db: ctx.db,
      companyId: ctx.target.companyId,
      documentId: resource.documentId,
    });
    const now = new Date();
    return {
      ...view,
      pdfDownloadUrl: storedSharePdfDownloadUrl(
        resource.pdfDownloadUrl,
        resource.pdfDownloadExpiresAt,
        now,
      ),
      signedDownloadUrl: storedShareDownloadUrl(
        resource.signedDownloadUrl,
        resource.signedDownloadExpiresAt,
        now,
      ),
    };
  },
});
