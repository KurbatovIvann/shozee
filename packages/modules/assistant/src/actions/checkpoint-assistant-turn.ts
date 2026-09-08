import { implementAction } from "@showzy/core";
import { checkpointStaffAssistantTurn } from "../services/checkpoint-assistant-turn.js";
import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { checkpointAssistantTurnContract } from "./checkpoint-assistant-turn.contract.js";

export const checkpointAssistantTurn = implementAction(
  checkpointAssistantTurnContract,
  {
    handler: async (input, ctx) => {
      return checkpointStaffAssistantTurn({ ctx, input });
    },
    auditTarget: conversationAuditTarget,
  },
);
