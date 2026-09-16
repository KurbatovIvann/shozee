import { implementAction, type AuditTargetEnv } from "@showzy/core";

import { sweepSystemOverdueTurns } from "../services/turns.js";
import { sweepOverdueTurnsContract } from "./sweep-overdue-turns.contract.js";

function sweepAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  return {
    type: "assistant_turns_sweep",
    id: env.ctx === undefined ? "unknown" : env.ctx.requestId,
  };
}

export const sweepOverdueTurns = implementAction(sweepOverdueTurnsContract, {
  handler: (input, ctx) => sweepSystemOverdueTurns({ ctx, input }),
  auditTarget: sweepAuditTarget,
});
