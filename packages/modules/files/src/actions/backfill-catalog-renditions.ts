import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { runCatalogRenditionBackfill } from "../services/backfill-catalog-renditions.js";
import { backfillCatalogRenditionsContract } from "./backfill-catalog-renditions.contract.js";

function backfillAuditTarget(env: AuditTargetEnv): {
  type: string;
  id: string;
} {
  if (env.ctx !== undefined) {
    return { type: "files_backfill", id: env.ctx.requestId };
  }
  return { type: "files_backfill", id: "unknown" };
}

export const backfillCatalogRenditions = implementAction(
  backfillCatalogRenditionsContract,
  {
    handler: async (input, ctx) => {
      if (ctx.scope !== "global") {
        throw new CoreInvariantError(
          "files.backfillCatalogRenditions expects global system",
        );
      }
      return runCatalogRenditionBackfill({ ctx, input });
    },
    auditTarget: backfillAuditTarget,
  },
);
