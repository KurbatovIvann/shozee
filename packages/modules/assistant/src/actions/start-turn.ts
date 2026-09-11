import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { startStaffTurn } from "../services/turns.js";
import { startTurnContract } from "./start-turn.contract.js";

export const startTurn = implementAction(startTurnContract, {
  handler: (input, ctx) => startStaffTurn({ ctx, input }),
  auditTarget: conversationAuditTarget,
});
