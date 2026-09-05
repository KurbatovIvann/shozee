import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { z } from "zod";

import { renderPdfContract } from "./render-pdf.contract.js";
import { renderTenantDocumentPdf } from "../services/render-pdf.js";

const documentIdHolder = z.object({
  payload: z.object({ documentId: z.string() }),
});
const outputDocumentIdHolder = z.object({ documentId: z.string() });

function renderAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const fromOutput = outputDocumentIdHolder.safeParse(env.output);
  if (fromOutput.success) {
    return { type: "document", id: fromOutput.data.documentId };
  }
  const fromInput = documentIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: fromInput.success ? fromInput.data.payload.documentId : "unknown",
  };
}

export const renderPdf = implementAction(renderPdfContract, {
  handler: async (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "docGeneration.renderPdf expects tenant system",
      );
    }
    return renderTenantDocumentPdf({
      ctx,
      eventId: input.eventId,
      documentId: input.payload.documentId,
    });
  },
  auditTarget: renderAuditTarget,
});
