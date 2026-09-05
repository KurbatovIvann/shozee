import { implementAction } from "@showzy/core";
import { getStaffSigningDownloadUrl } from "../services/get-download-url.js";
import { issueSigningDownloadUrlContract } from "./issue-signing-download-url.contract.js";

export const issueSigningDownloadUrl = implementAction(
  issueSigningDownloadUrlContract,
  {
    handler: async (input, ctx) => {
      return getStaffSigningDownloadUrl({ ctx, input });
    },
  },
);
