import { implementAction } from "@showzy/core";
import { getStaffSigningDownloadUrl } from "../services/get-download-url.js";
import { issueShareSigningDownloadUrlContract } from "./issue-share-signing-download-url.contract.js";

export const issueShareSigningDownloadUrl = implementAction(
  issueShareSigningDownloadUrlContract,
  {
    handler: async (input, ctx) => {
      return getStaffSigningDownloadUrl({ ctx, input });
    },
  },
);
