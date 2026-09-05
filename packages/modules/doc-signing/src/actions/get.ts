import { implementAction } from "@showzy/core";
import {
  signingRequests,
  signingSignatures,
} from "@showzy/db/schema/doc-signing";
import { and, eq } from "drizzle-orm";

import { getSigningContract } from "./get.contract.js";

export const getSigning = implementAction(getSigningContract, {
  handler: async (input, ctx) => {
    const signatureRows = await ctx.db
      .select({ fileId: signingSignatures.fileId })
      .from(signingSignatures)
      .where(
        and(
          eq(signingSignatures.companyId, ctx.companyId),
          eq(signingSignatures.documentId, input.documentId),
          eq(signingSignatures.signerRole, "supplier"),
        ),
      )
      .limit(1);
    const signature = signatureRows[0];
    if (signature !== undefined) {
      return {
        status: "supplier_signed" as const,
        signedFileId: signature.fileId,
      };
    }

    const requestRows = await ctx.db
      .select({ id: signingRequests.id })
      .from(signingRequests)
      .where(
        and(
          eq(signingRequests.companyId, ctx.companyId),
          eq(signingRequests.documentId, input.documentId),
          eq(signingRequests.status, "pending"),
        ),
      )
      .limit(1);
    const pending = requestRows[0];
    if (pending !== undefined) {
      return { status: "pending" as const, requestId: pending.id };
    }

    // Signing-owned state only. Missing and foreign document ids are
    // unsigned here (no existence leak). Existence stays on documents.get.
    return { status: "unsigned" as const };
  },
});
