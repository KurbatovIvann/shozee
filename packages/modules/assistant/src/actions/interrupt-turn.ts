import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { interruptSystemTurn } from "../services/turns.js";
import { interruptTurnContract } from "./interrupt-turn.contract.js";

export const interruptTurn = implementAction(interruptTurnContract, {
  handler: (input, ctx) => interruptSystemTurn({ ctx, input }),
  auditTarget: conversationAuditTarget,
});
