import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { runAbandonedUploadSweep } from "../services/sweep-abandoned-uploads.js";
import { sweepAbandonedUploadsContract } from "./sweep-abandoned-uploads.contract.js";

function sweepAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  if (env.ctx !== undefined) {
    return { type: "files_sweep", id: env.ctx.requestId };
  }
  return { type: "files_sweep", id: "unknown" };
}

export const sweepAbandonedUploads = implementAction(
  sweepAbandonedUploadsContract,
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "global") {
        throw new CoreInvariantError(
          "files.sweepAbandonedUploads expects global system",
        );
      }
      return runAbandonedUploadSweep({ ctx, input });
    },
    auditTarget: sweepAuditTarget,
  },
);
