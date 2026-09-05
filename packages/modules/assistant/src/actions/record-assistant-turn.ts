import { implementAction } from "@showzy/core";
import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { recordStaffAssistantTurn } from "../services/record-assistant-turn.js";
import { recordAssistantTurnContract } from "./record-assistant-turn.contract.js";

export const recordAssistantTurn = implementAction(
  recordAssistantTurnContract,
  {
    handler: async (input, ctx) => {
      return recordStaffAssistantTurn({ ctx, input });
    },
    auditTarget: conversationAuditTarget,
  },
);
