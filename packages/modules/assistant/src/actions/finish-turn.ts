import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { finishStaffTurn } from "../services/turns.js";
import { finishTurnContract } from "./finish-turn.contract.js";

export const finishTurn = implementAction(finishTurnContract, {
  handler: (input, ctx) => finishStaffTurn({ ctx, input }),
  auditTarget: conversationAuditTarget,
});
