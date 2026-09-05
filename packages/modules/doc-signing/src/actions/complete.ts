import { implementAction, type AuditTargetEnv } from "@showzy/core";
import {
  CoreInvariantError,
  NotFoundError,
  ValidationError,
} from "@showzy/core/errors";
import {
  signingRequests,
  signingSignatures,
} from "@showzy/db/schema/doc-signing";
import { lockIssuedForSigning } from "@showzy/documents";
import {
  AsicContainerError,
  VerifyFailedError,
  verifyAsicE,
} from "@showzy/document-signing/node";
import { readPendingSigningObject, recordSigningObject } from "@showzy/files";
import { postgresUniqueConstraint } from "@showzy/module-kit/postgres-unique";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { completeSigningContract } from "./complete.contract.js";
import { docSigningRecorded } from "../events/recorded.js";
import {
  type CertSnapshot,
  type CompleteSigningView,
  completeSigningView,
  loadSupplierSignature,
  resolveExistingSignature,
  snapshotFromSignature,
} from "../services/resolve-existing-signature.js";
import { requireStaffWritable } from "../services/writable.js";

export { ALREADY_SIGNED_MESSAGE } from "@showzy/validation/signing";
export { DIFFERENT_FILE_MESSAGE } from "../services/resolve-existing-signature.js";
export const INVALID_ASIC_MESSAGE =
  "The uploaded file is not a valid signed ASiC-E container.";
export const PAYLOAD_MISMATCH_MESSAGE =
  "The signed payload does not match the document frozen at start.";

export const SIGNING_SIGNATURES_DOCUMENT_ID_SIGNER_ROLE_UQ =
  "signing_signatures_document_id_signer_role_uq";

const documentIdHolder = z.object({ documentId: z.string() });

const asicValidGate = z.object({
  valid: z.literal(true, { error: INVALID_ASIC_MESSAGE }),
});

const digestMatchGate = z.object({
  match: z.literal(true, { error: PAYLOAD_MISMATCH_MESSAGE }),
});

/**
 * Request-scoped: execute-action passes the same validated `input` object
 * to the handler and to `auditSnapshot`. WeakMap keys that object so
 * concurrent completes cannot collide and nothing is process-global.
 */
const auditSnapshots = new WeakMap<object, CertSnapshot>();

function stashSnapshot(input: object, snap: CertSnapshot): void {
  auditSnapshots.set(input, snap);
}

function completeAuditTarget(env: AuditTargetEnv): {
  type: string;
  id: string;
} {
  const parsed = documentIdHolder.safeParse(env.output);
  return {
    type: "document",
    id: parsed.success ? parsed.data.documentId : "unknown",
  };
}

function completeAuditSnapshot(input: {
  readonly requestId: string;
  readonly fileId: string;
}): CertSnapshot | { readonly requestId: string; readonly fileId: string } {
  const snap = auditSnapshots.get(input);
  if (snap === undefined) {
    return { requestId: input.requestId, fileId: input.fileId };
  }
  auditSnapshots.delete(input);
  return snap;
}

function requireValidAsic(): never {
  const parsed = asicValidGate.safeParse({ valid: false });
  if (parsed.success) {
    throw new CoreInvariantError("ASiC validation fixture produced success");
  }
  throw new ValidationError(parsed.error.issues, INVALID_ASIC_MESSAGE);
}

function requireMatchingDigest(actual: string, expected: string): void {
  const parsed = digestMatchGate.safeParse({ match: actual === expected });
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues, PAYLOAD_MISMATCH_MESSAGE);
  }
}

type RequestRow = {
  readonly id: string;
  readonly documentId: string;
  readonly payloadSha256: string;
  readonly status: string;
};

function replayResolved(
  input: object,
  resolved: {
    readonly output: CompleteSigningView;
    readonly snapshot: CertSnapshot;
  },
): CompleteSigningView {
  stashSnapshot(input, resolved.snapshot);
  return resolved.output;
}

async function loadRequest(env: {
  readonly db: ReturnType<typeof requireStaffWritable>;
  readonly companyId: string;
  readonly requestId: string;
  readonly lock?: boolean;
}): Promise<RequestRow | undefined> {
  const query = env.db
    .select({
      id: signingRequests.id,
      documentId: signingRequests.documentId,
      payloadSha256: signingRequests.payloadSha256,
      status: signingRequests.status,
    })
    .from(signingRequests)
    .where(
      and(
        eq(signingRequests.companyId, env.companyId),
        eq(signingRequests.id, env.requestId),
      ),
    )
    .limit(1);
  const rows = env.lock === true ? await query.for("update") : await query;
  return rows[0];
}

export const completeSigning = implementAction(completeSigningContract, {
  handler: async (input, ctx) => {
    const db = requireStaffWritable(ctx.db);
    const request = await loadRequest({
      db,
      companyId: ctx.companyId,
      requestId: input.requestId,
    });
    if (request === undefined) {
      throw new NotFoundError();
    }

    if (request.status === "completed") {
      const existing = await loadSupplierSignature({
        db,
        companyId: ctx.companyId,
        documentId: request.documentId,
      });
      if (existing === undefined) {
        throw new CoreInvariantError(
          "docSigning.complete completed request is missing a signature",
        );
      }
      return replayResolved(
        input,
        resolveExistingSignature({
          signature: existing,
          fileId: input.fileId,
          documentId: request.documentId,
          requestId: request.id,
        }),
      );
    }
    if (request.status !== "pending") {
      throw new CoreInvariantError("docSigning.complete saw an unknown status");
    }

    const already = await loadSupplierSignature({
      db,
      companyId: ctx.companyId,
      documentId: request.documentId,
    });
    if (already !== undefined) {
      return replayResolved(
        input,
        resolveExistingSignature({
          signature: already,
          fileId: input.fileId,
          documentId: request.documentId,
          requestId: request.id,
        }),
      );
    }

    const staging = await ctx.call(readPendingSigningObject, {
      fileId: input.fileId,
    });

    let verified: Awaited<ReturnType<typeof verifyAsicE>>;
    try {
      verified = await verifyAsicE(staging.bytes);
    } catch (error) {
      if (
        error instanceof AsicContainerError ||
        error instanceof VerifyFailedError
      ) {
        requireValidAsic();
      }
      throw error;
    }
    requireMatchingDigest(verified.payloadSha256, request.payloadSha256);

    const signedAt = new Date(verified.signedAt);
    const signature = {
      fileId: input.fileId,
      signerCn: verified.signerCn.length > 0 ? verified.signerCn : "unknown",
      signerOrg: verified.signerOrg,
      signerTaxId: verified.signerTaxId,
      signatureAlg: verified.signatureAlg,
      signedAt: Number.isFinite(signedAt.getTime()) ? signedAt : new Date(),
    };

    // Re-assert issued + unexpired grant AFTER verify and immediately
    // before the unique supplier insert. Nesting lockIssuedForSigning
    // before S3 GET + UAPKI VERIFY would hold the documents row FOR
    // UPDATE across complete's 30s budget (blocking cancel). Cancel
    // that commits in that window fails this re-lock; a signature is
    // never recorded on a cancelled document.
    await ctx.call(lockIssuedForSigning, {
      documentId: request.documentId,
    });

    const locked = await loadRequest({
      db,
      companyId: ctx.companyId,
      requestId: request.id,
      lock: true,
    });
    if (locked === undefined) {
      throw new NotFoundError();
    }
    if (locked.status === "completed") {
      const existing = await loadSupplierSignature({
        db,
        companyId: ctx.companyId,
        documentId: locked.documentId,
      });
      if (existing === undefined) {
        throw new CoreInvariantError(
          "docSigning.complete completed request is missing a signature",
        );
      }
      return replayResolved(
        input,
        resolveExistingSignature({
          signature: existing,
          fileId: input.fileId,
          documentId: locked.documentId,
          requestId: locked.id,
        }),
      );
    }
    if (locked.status !== "pending") {
      throw new CoreInvariantError("docSigning.complete saw an unknown status");
    }

    const claimed = await loadSupplierSignature({
      db,
      companyId: ctx.companyId,
      documentId: locked.documentId,
    });
    if (claimed !== undefined) {
      return replayResolved(
        input,
        resolveExistingSignature({
          signature: claimed,
          fileId: input.fileId,
          documentId: locked.documentId,
          requestId: locked.id,
        }),
      );
    }

    try {
      await db.insert(signingSignatures).values({
        companyId: ctx.companyId,
        documentId: locked.documentId,
        signerRole: "supplier",
        fileId: signature.fileId,
        signerCn: signature.signerCn,
        signerOrg: signature.signerOrg,
        signerTaxId: signature.signerTaxId,
        signatureAlg: signature.signatureAlg,
        signedAt: signature.signedAt,
      });
    } catch (error) {
      if (
        postgresUniqueConstraint(error) !==
        SIGNING_SIGNATURES_DOCUMENT_ID_SIGNER_ROLE_UQ
      ) {
        throw error;
      }
      const raced = await loadSupplierSignature({
        db,
        companyId: ctx.companyId,
        documentId: locked.documentId,
      });
      if (raced === undefined) {
        throw new CoreInvariantError(
          "docSigning.complete unique race lost a signature",
        );
      }
      return replayResolved(
        input,
        resolveExistingSignature({
          signature: raced,
          fileId: input.fileId,
          documentId: locked.documentId,
          requestId: locked.id,
        }),
      );
    }

    await ctx.callAtomic(recordSigningObject, {
      fileId: input.fileId,
      purpose: "signing",
      mimeType: staging.mimeType,
      byteSize: staging.byteSize,
      checksumSha256: staging.checksumSha256,
    });

    const updated = await db
      .update(signingRequests)
      .set({
        status: "completed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(signingRequests.companyId, ctx.companyId),
          eq(signingRequests.id, locked.id),
          eq(signingRequests.status, "pending"),
        ),
      )
      .returning({ id: signingRequests.id });
    if (updated[0] === undefined) {
      throw new CoreInvariantError(
        "docSigning.complete lost the pending request",
      );
    }

    ctx.emit(docSigningRecorded, {
      aggregate: { type: "document", id: locked.documentId },
      payload: {
        documentId: locked.documentId,
        signerRole: "supplier",
        fileId: input.fileId,
      },
    });

    stashSnapshot(input, snapshotFromSignature(locked.documentId, signature));
    return completeSigningView({
      documentId: locked.documentId,
      requestId: locked.id,
      signature,
    });
  },
  auditTarget: completeAuditTarget,
  auditSnapshot: completeAuditSnapshot,
});
