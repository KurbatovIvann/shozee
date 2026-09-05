import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import { and, eq } from "drizzle-orm";

import {
  generationJobStatusSchema,
  getArtifactContract,
} from "./get-artifact.contract.js";

export const getArtifact = implementAction(getArtifactContract, {
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select({
        status: documentGenerationJobs.status,
        fileId: documentGenerationJobs.fileId,
      })
      .from(documentGenerationJobs)
      .where(
        and(
          eq(documentGenerationJobs.companyId, ctx.companyId),
          eq(documentGenerationJobs.documentId, input.documentId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError();
    }
    const status = generationJobStatusSchema.safeParse(row.status);
    if (!status.success) {
      throw new CoreInvariantError(
        `document_generation_jobs row has illegal status "${row.status}"`,
      );
    }
    return { status: status.data, fileId: row.fileId };
  },
});
