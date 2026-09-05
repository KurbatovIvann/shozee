import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { getSystemSigningDownloadUrl } from "../services/get-download-url.js";
import { issueSystemSigningDownloadUrlContract } from "./issue-system-signing-download-url.contract.js";

export const issueSystemSigningDownloadUrl = implementAction(
  issueSystemSigningDownloadUrlContract,
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError(
          "files.issueSystemSigningDownloadUrl expects tenant system",
        );
      }
      return getSystemSigningDownloadUrl({ ctx, input });
    },
  },
);
