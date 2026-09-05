import { implementAction } from "@showzy/core";
import { getStaffDocumentDownloadUrl } from "../services/get-download-url.js";
import { issueShareDownloadUrlContract } from "./issue-share-download-url.contract.js";

export const issueShareDownloadUrl = implementAction(
  issueShareDownloadUrlContract,
  {
    handler: async (input, ctx) => {
      const issued = await getStaffDocumentDownloadUrl({ ctx, input });
      return {
        fileId: issued.fileId,
        downloadUrl: issued.downloadUrl,
        expiresAt: issued.expiresAt,
      };
    },
  },
);
