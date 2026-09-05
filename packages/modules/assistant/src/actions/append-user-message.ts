import { implementAction } from "@showzy/core";
import { appendStaffUserMessage } from "../services/append-user-message.js";
import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { appendUserMessageContract } from "./append-user-message.contract.js";

export const appendUserMessage = implementAction(appendUserMessageContract, {
  handler: async (input, ctx) => {
    return appendStaffUserMessage({ ctx, input });
  },
  auditTarget: conversationAuditTarget,
});
