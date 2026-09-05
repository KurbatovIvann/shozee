import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import { issueDocumentDownloadUrl } from "@showzy/files";

import { getDocumentContract } from "./get.contract.js";
import {
  loadGenerationArtifact,
  readyArtifactFileId,
} from "../services/load-generation.js";
import { loadStaffDocumentWithGrant } from "../services/load-document.js";

export const getDocument = implementAction(getDocumentContract, {
  handler: async (input, ctx) => {
    const { view, signRequestedAt } = await loadStaffDocumentWithGrant({
      db: ctx.db,
      companyId: ctx.companyId,
      documentId: input.documentId,
    });
    const generation = await loadGenerationArtifact({
      documentId: input.documentId,
      getArtifact: (body) => ctx.call(getArtifact, body),
    });
    const fileId = readyArtifactFileId(generation);
    let pdfDownloadUrl: string | null = null;
    if (fileId !== null) {
      try {
        const issued = await ctx.call(issueDocumentDownloadUrl, { fileId });
        pdfDownloadUrl = issued.downloadUrl;
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
    }
    const signing = await ctx.call(getSigning, {
      documentId: input.documentId,
    });
    return {
      ...view,
      generation,
      pdfDownloadUrl,
      signing,
      signRequestedAt,
    };
  },
});
