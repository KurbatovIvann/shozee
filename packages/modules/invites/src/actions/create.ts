import { implementAction } from "@showzy/core";
import { createInviteContract } from "./create.contract.js";
import { inviteAuditTarget } from "../services/invite-audit-target.js";
import { createStaffInvite } from "../services/create-invite.js";

export const createInvite = implementAction(createInviteContract, {
  handler: (input, ctx) => {
    return createStaffInvite({ ctx, input });
  },
  auditTarget: inviteAuditTarget,
});
