import { implementAction } from "@showzy/core";
import { getStaffSigningUploadUrl } from "../services/get-upload-url.js";
import { getSigningUploadUrlContract } from "./get-signing-upload-url.contract.js";

export const getSigningUploadUrl = implementAction(
  getSigningUploadUrlContract,
  {
    handler: async (input, ctx) => {
      return getStaffSigningUploadUrl({ ctx, input });
    },
  },
);
