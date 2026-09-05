import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { fileAuditTarget } from "../services/file-audit-target.js";
import { recordGeneratedDocumentObject } from "../services/record-generated-object.js";
import { recordGeneratedObjectContract } from "./record-generated-object.contract.js";

export const recordGeneratedObject = implementAction(
  recordGeneratedObjectContract,
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "tenant") {
        throw new CoreInvariantError(
          "files.recordGeneratedObject expects tenant system",
        );
      }
      return recordGeneratedDocumentObject({ ctx, input });
    },
    auditTarget: fileAuditTarget,
  },
);
