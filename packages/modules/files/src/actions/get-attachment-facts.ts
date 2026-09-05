import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { files } from "@showzy/db/schema/files";
import { uniqueIds } from "@showzy/module-kit/unique-ids";
import { and, eq, inArray } from "drizzle-orm";

import { toReadyView } from "../services/file-view.js";
import { getAttachmentFactsContract } from "./get-attachment-facts.contract.js";

export const getAttachmentFacts = implementAction(getAttachmentFactsContract, {
  handler: async (input, ctx) => {
    const fileIds = uniqueIds(input.fileIds);
    const rows = await ctx.db
      .select({
        id: files.id,
        purpose: files.purpose,
        mimeType: files.mimeType,
        byteSize: files.byteSize,
        checksumSha256: files.checksumSha256,
        status: files.status,
      })
      .from(files)
      .where(
        and(
          eq(files.companyId, ctx.companyId),
          eq(files.status, "ready"),
          eq(files.purpose, "catalog"),
          inArray(files.id, fileIds),
        ),
      );

    if (rows.length !== fileIds.length) {
      throw new NotFoundError();
    }

    const rowById = new Map(rows.map((row) => [row.id, row]));
    return {
      files: fileIds.map((fileId) => {
        const row = rowById.get(fileId);
        if (row === undefined) {
          throw new CoreInvariantError(
            "file row missing after the existence check",
          );
        }
        return toReadyView(row);
      }),
    };
  },
});
