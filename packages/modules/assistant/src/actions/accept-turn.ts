import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { acceptStaffTurn } from "../services/turns.js";
import { acceptTurnContract } from "./accept-turn.contract.js";

export const acceptTurn = implementAction(acceptTurnContract, {
  handler: (input, ctx) => acceptStaffTurn({ ctx, input }),
  auditTarget: conversationAuditTarget,
});
