import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { z } from "zod";

import { markFailedContract } from "./mark-failed.contract.js";
import { markTenantDocumentFailed } from "../services/mark-failed.js";

const documentIdHolder = z.object({ documentId: z.string() });
const outputDocumentIdHolder = z.object({ documentId: z.string() });

function markFailedAuditTarget(env: AuditTargetEnv): {
  type: string;
  id: string;
} {
  const fromOutput = outputDocumentIdHolder.safeParse(env.output);
  if (fromOutput.success) {
    return { type: "document", id: fromOutput.data.documentId };
  }
  const fromInput = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: fromInput.success ? fromInput.data.documentId : "unknown",
  };
}

export const markFailed = implementAction(markFailedContract, {
  handler: async (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "docGeneration.markFailed expects tenant system",
      );
    }
    return markTenantDocumentFailed({
      ctx,
      documentId: input.documentId,
    });
  },
  auditTarget: markFailedAuditTarget,
});
