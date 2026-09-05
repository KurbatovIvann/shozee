import { implementAction } from "@showzy/core";
import { getStaffDownloadUrls } from "../services/get-download-url.js";
import { getDownloadUrlsContract } from "./get-download-urls.contract.js";

export const getDownloadUrls = implementAction(getDownloadUrlsContract, {
  handler: async (input, ctx) => {
    return getStaffDownloadUrls({ ctx, input });
  },
});
