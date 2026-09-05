import { implementAction, type AuditTargetEnv } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { signingRequests } from "@showzy/db/schema/doc-signing";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { lockIssuedForSigning } from "@showzy/documents";
import { issueDocumentDownloadUrl } from "@showzy/files";
import { postgresUniqueConstraint } from "@showzy/module-kit/postgres-unique";
import { requireOrValidationError } from "@showzy/module-kit/require";
import {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_START_MESSAGE,
  GRANT_EXPIRED_MESSAGE,
  GRANT_MISSING_MESSAGE,
  PDF_NOT_READY_MESSAGE,
  readyPdfGate,
} from "@showzy/validation/signing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { startSigningContract } from "./start.contract.js";
import { loadSupplierSignature } from "../services/resolve-existing-signature.js";
import { requireStaffWritable } from "../services/writable.js";

export {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_START_MESSAGE,
  GRANT_EXPIRED_MESSAGE,
  GRANT_MISSING_MESSAGE,
  PDF_NOT_READY_MESSAGE,
};

export const SIGNING_REQUESTS_DOCUMENT_PENDING_UQ =
  "signing_requests_document_id_pending_uq";

const documentIdHolder = z.object({ documentId: z.string() });

function startAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const parsed = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: parsed.success ? parsed.data.documentId : "unknown",
  };
}

function requireReadyFileId(fileId: string | null): string {
  requireOrValidationError(
    readyPdfGate,
    { present: fileId !== null },
    PDF_NOT_READY_MESSAGE,
  );
  if (fileId === null) {
    throw new CoreInvariantError("ready PDF gate passed with a null file id");
  }
  return fileId;
}

type PendingRequest = {
  readonly id: string;
  readonly payloadFileId: string;
  readonly payloadSha256: string;
};

type IssuedDownload = {
  readonly downloadUrl: string;
  readonly expiresAt: string;
  readonly checksumSha256: string;
};

async function loadPendingRequest(env: {
  readonly db: ReturnType<typeof requireStaffWritable>;
  readonly companyId: string;
  readonly documentId: string;
}): Promise<PendingRequest | undefined> {
  const rows = await env.db
    .select({
      id: signingRequests.id,
      payloadFileId: signingRequests.payloadFileId,
      payloadSha256: signingRequests.payloadSha256,
    })
    .from(signingRequests)
    .where(
      and(
        eq(signingRequests.companyId, env.companyId),
        eq(signingRequests.documentId, env.documentId),
        eq(signingRequests.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0];
}

async function loadReadyPayloadFileId(env: {
  readonly documentId: string;
  readonly getArtifact: (input: { readonly documentId: string }) => Promise<{
    readonly status: "pending" | "ready" | "failed";
    readonly fileId: string | null;
  }>;
}): Promise<string> {
  let artifact: {
    readonly status: "pending" | "ready" | "failed";
    readonly fileId: string | null;
  };
  try {
    artifact = await env.getArtifact({ documentId: env.documentId });
  } catch (error) {
    if (error instanceof NotFoundError) {
      artifact = { status: "pending", fileId: null };
    } else {
      throw error;
    }
  }
  const fileId = artifact.status === "ready" ? artifact.fileId : null;
  return requireReadyFileId(fileId);
}

function startOutput(env: {
  readonly request: PendingRequest;
  readonly documentId: string;
  readonly issued: IssuedDownload;
}) {
  return {
    requestId: env.request.id,
    documentId: env.documentId,
    payloadFileId: env.request.payloadFileId,
    payloadSha256: env.request.payloadSha256,
    payloadDigestAlgorithm: "sha256" as const,
    payloadDownloadUrl: env.issued.downloadUrl,
    payloadDownloadExpiresAt: env.issued.expiresAt,
  };
}

export const startSigning = implementAction(startSigningContract, {
  handler: async (input, ctx) => {
    await ctx.call(lockIssuedForSigning, {
      documentId: input.documentId,
    });

    const db = requireStaffWritable(ctx.db);
    const signed = await loadSupplierSignature({
      db,
      companyId: ctx.companyId,
      documentId: input.documentId,
    });
    if (signed !== undefined) {
      throw new ConflictError(ALREADY_SIGNED_MESSAGE);
    }

    const existing = await loadPendingRequest({
      db,
      companyId: ctx.companyId,
      documentId: input.documentId,
    });
    if (existing !== undefined) {
      const issued = await ctx.call(issueDocumentDownloadUrl, {
        fileId: existing.payloadFileId,
      });
      return startOutput({
        request: existing,
        documentId: input.documentId,
        issued,
      });
    }

    const payloadFileId = await loadReadyPayloadFileId({
      documentId: input.documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    const issued = await ctx.call(issueDocumentDownloadUrl, {
      fileId: payloadFileId,
    });

    try {
      const inserted = await db
        .insert(signingRequests)
        .values({
          companyId: ctx.companyId,
          documentId: input.documentId,
          payloadFileId,
          payloadSha256: issued.checksumSha256,
          payloadDigestAlgorithm: "sha256",
          status: "pending",
        })
        .returning({
          id: signingRequests.id,
          payloadFileId: signingRequests.payloadFileId,
          payloadSha256: signingRequests.payloadSha256,
        });
      const row = inserted[0];
      if (row === undefined) {
        throw new CoreInvariantError("docSigning.start insert returned no row");
      }
      return startOutput({
        request: row,
        documentId: input.documentId,
        issued,
      });
    } catch (error) {
      if (
        postgresUniqueConstraint(error) !== SIGNING_REQUESTS_DOCUMENT_PENDING_UQ
      ) {
        throw error;
      }
      const raced = await loadPendingRequest({
        db,
        companyId: ctx.companyId,
        documentId: input.documentId,
      });
      if (raced === undefined) {
        throw new CoreInvariantError(
          "docSigning.start unique race lost a pending request",
        );
      }
      const racedIssued = await ctx.call(issueDocumentDownloadUrl, {
        fileId: raced.payloadFileId,
      });
      return startOutput({
        request: raced,
        documentId: input.documentId,
        issued: racedIssued,
      });
    }
  },
  auditTarget: startAuditTarget,
});
