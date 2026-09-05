import { implementAction } from "@showzy/core";
import { fileAuditTarget } from "../services/file-audit-target.js";
import { requestStaffSigningUpload } from "../services/request-upload.js";
import { requestSigningUploadContract } from "./request-signing-upload.contract.js";

export const requestSigningUpload = implementAction(
  requestSigningUploadContract,
  {
    handler: async (input, ctx) => {
      return requestStaffSigningUpload({ ctx, input });
    },
    auditTarget: fileAuditTarget,
  },
);
