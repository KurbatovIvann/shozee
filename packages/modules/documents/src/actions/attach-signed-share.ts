import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { documents, documentShareTokens } from "@showzy/db/schema/documents";
import { issueSystemSigningDownloadUrl } from "@showzy/files";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { attachSignedShareContract } from "./attach-signed-share.contract.js";
import { requireSystemWritable } from "../services/writable.js";

const documentIdHolder = z.object({ documentId: z.string() });
const envelopeDocumentIdHolder = z.object({
  payload: z.object({ documentId: z.string() }),
});

function attachAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const fromOutput = documentIdHolder.safeParse(env.output);
  if (fromOutput.success) {
    return { type: "document", id: fromOutput.data.documentId };
  }
  const fromInput = envelopeDocumentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: fromInput.success ? fromInput.data.payload.documentId : "unknown",
  };
}

export const attachSignedShare = implementAction(attachSignedShareContract, {
  handler: async (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "documents.attachSignedShare expects tenant system",
      );
    }

    const documentId = input.payload.documentId;
    const db = requireSystemWritable(ctx.db);
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

    const active = await db
      .select({
        id: documentShareTokens.id,
        tokenHash: documentShareTokens.tokenHash,
      })
      .from(documentShareTokens)
      .where(
        and(
          eq(documentShareTokens.companyId, ctx.companyId),
          eq(documentShareTokens.documentId, documentId),
          isNull(documentShareTokens.revokedAt),
        ),
      )
      .limit(1)
      .for("update");
    const token = active[0];
    if (token === undefined) {
      return { documentId };
    }

    const minted = await ctx.call(issueSystemSigningDownloadUrl, {
      fileId: input.payload.fileId,
    });

    await db
      .update(documentShareTokens)
      .set({
        signedDownloadUrl: minted.downloadUrl,
        signedDownloadExpiresAt: new Date(minted.expiresAt),
      })
      .where(
        and(
          eq(documentShareTokens.companyId, ctx.companyId),
          eq(documentShareTokens.id, token.id),
          eq(documentShareTokens.tokenHash, token.tokenHash),
          isNull(documentShareTokens.revokedAt),
        ),
      );

    return { documentId };
  },
  auditTarget: attachAuditTarget,
});
