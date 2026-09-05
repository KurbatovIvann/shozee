import { implementAction } from "@showzy/core";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { CANCELLED_REQUEST_SIGN_MESSAGE } from "@showzy/validation/signing";
import { and, eq } from "drizzle-orm";

import { lockIssuedForSigningContract } from "./lock-issued-for-signing.contract.js";
import {
  loadGenerationArtifact,
  readyArtifactFileId,
} from "../services/load-generation.js";
import {
  requireReadyPdf,
  requireUnexpiredGrant,
} from "../services/signing-gates.js";

export {
  GRANT_EXPIRED_MESSAGE,
  GRANT_MISSING_MESSAGE,
} from "@showzy/validation/signing";

export const lockIssuedForSigning = implementAction(
  lockIssuedForSigningContract,
  {
    handler: async (input, ctx) => {
      // Header lock copies `documents.requestSign` / `documents.cancel`.
      const rows = await ctx.db
        .select({
          status: documents.status,
          signRequestedAt: documents.signRequestedAt,
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
      if (row.status !== "issued") {
        throw new ConflictError(CANCELLED_REQUEST_SIGN_MESSAGE);
      }
      requireUnexpiredGrant(row.signRequestedAt);

      const generation = await loadGenerationArtifact({
        documentId: input.documentId,
        getArtifact: (body) => ctx.call(getArtifact, body),
      });
      requireReadyPdf(readyArtifactFileId(generation));

      return { documentId: input.documentId };
    },
  },
);
