import { implementAction } from "@showzy/core";

import { assistantTurnJob } from "../jobs.js";
import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { acceptStaffTurn } from "../services/turns.js";
import { acceptTurnContract } from "./accept-turn.contract.js";

export const acceptTurn = implementAction(acceptTurnContract, {
  handler: async (input, ctx) => {
    const accepted = await acceptStaffTurn({ ctx, input });
    if (accepted.outcome === "accepted") {
      ctx.enqueue(assistantTurnJob, {
        kind: accepted.turn.kind,
        conversationId: accepted.conversationId,
        commandId: accepted.turn.commandId,
      });
    }
    return accepted;
  },
  auditTarget: conversationAuditTarget,
});
