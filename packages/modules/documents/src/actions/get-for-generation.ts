import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { getForGenerationContract } from "./get-for-generation.contract.js";
import { loadStaffDocument } from "../services/load-document.js";

export const getForGeneration = implementAction(getForGenerationContract, {
  handler: async (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "documents.getForGeneration expects tenant system",
      );
    }
    return loadStaffDocument({
      db: ctx.db,
      companyId: ctx.companyId,
      documentId: input.documentId,
    });
  },
});
