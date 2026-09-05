import { implementAction } from "@showzy/core";
import { getStaffDocumentDownloadUrl } from "../services/get-download-url.js";
import { issueDocumentDownloadUrlContract } from "./issue-document-download-url.contract.js";

export const issueDocumentDownloadUrl = implementAction(
  issueDocumentDownloadUrlContract,
  {
    handler: async (input, ctx) => {
      return getStaffDocumentDownloadUrl({ ctx, input });
    },
  },
);
