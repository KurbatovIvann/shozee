import { implementAction } from "@showzy/core";
import { getStaffDownloadUrl } from "../services/get-download-url.js";
import { getDownloadUrlContract } from "./get-download-url.contract.js";

export const getDownloadUrl = implementAction(getDownloadUrlContract, {
  handler: async (input, ctx) => {
    return getStaffDownloadUrl({ ctx, input });
  },
});
