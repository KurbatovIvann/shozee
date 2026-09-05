import { implementAction } from "@showzy/core";
import { fileAuditTarget } from "../services/file-audit-target.js";
import { requestStaffUpload } from "../services/request-upload.js";
import { requestUploadContract } from "./request-upload.contract.js";

export const requestUpload = implementAction(requestUploadContract, {
  handler: async (input, ctx) => {
    return requestStaffUpload({ ctx, input });
  },
  auditTarget: fileAuditTarget,
});
