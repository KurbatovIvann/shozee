import { CoreInvariantError } from "../../errors/index.js";
import type { CtxAuditTarget } from "../context/types.js";

export interface AuditTargetBox {
  readonly record: CtxAuditTarget;
  readonly resolvedId: () => string | undefined;
}

export function createAuditTargetBox(actionName: string): AuditTargetBox {
  let resolved: string | undefined;
  return {
    record: (id) => {
      if (resolved !== undefined) {
        throw new CoreInvariantError(
          `"${actionName}" called ctx.auditTarget twice (${resolved} then ${id}) — the resolved audit target is set once per invocation (core.md §8)`,
        );
      }
      resolved = id;
    },
    resolvedId: () => resolved,
  };
}
