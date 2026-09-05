import { implementAction } from "@showzy/core";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { updateStaffGroup } from "../services/update-group.js";
import { updateGroupContract } from "./update-group.contract.js";

export const updateGroup = implementAction(updateGroupContract, {
  handler: (input, ctx) => {
    return updateStaffGroup({ ctx, input });
  },
  auditTarget: groupAuditTarget,
});
