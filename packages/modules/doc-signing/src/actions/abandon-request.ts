import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { signingRequests } from "@showzy/db/schema/doc-signing";
import { getForGeneration } from "@showzy/documents";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { abandonRequestContract } from "./abandon-request.contract.js";
import { requireWritable } from "../services/writable.js";

const documentIdHolder = z.object({ documentId: z.string() });
const envelopeDocumentIdHolder = z.object({
  payload: z.object({ documentId: z.string() }),
});

function abandonAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
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

export const abandonRequest = implementAction(abandonRequestContract, {
  handler: async (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "docSigning.abandonRequest expects tenant system",
      );
    }

    const documentId = input.payload.documentId;
    await ctx.call(getForGeneration, { documentId });

    const db = requireWritable(ctx.db);
    await db
      .delete(signingRequests)
      .where(
        and(
          eq(signingRequests.companyId, ctx.companyId),
          eq(signingRequests.documentId, documentId),
          eq(signingRequests.status, "pending"),
        ),
      );

    return { documentId };
  },
  auditTarget: abandonAuditTarget,
});
