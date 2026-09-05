import { implementAction } from "@showzy/core";
import { fileAuditTarget } from "../services/file-audit-target.js";
import { finalizeStaffUpload } from "../services/finalize-upload.js";
import { finalizeUploadContract } from "./finalize-upload.contract.js";

export const finalizeUpload = implementAction(finalizeUploadContract, {
  handler: async (input, ctx) => {
    return finalizeStaffUpload({ ctx, input });
  },
  auditTarget: fileAuditTarget,
});
