import { implementAction } from "@showzy/core";
import { getStaffUploadUrl } from "../services/get-upload-url.js";
import { getUploadUrlContract } from "./get-upload-url.contract.js";

export const getUploadUrl = implementAction(getUploadUrlContract, {
  handler: async (input, ctx) => {
    return getStaffUploadUrl({ ctx, input });
  },
});
