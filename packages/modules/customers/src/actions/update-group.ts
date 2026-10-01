import { implementAction } from "@showzy/core";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { updateGroupPreview } from "../services/preview-card.js";
import { updateStaffGroup } from "../services/update-group.js";
import { updateGroupContract } from "./update-group.contract.js";

export const updateGroup = implementAction(updateGroupContract, {
  handler: (input, ctx) => {
    return updateStaffGroup({ ctx, input });
  },
  preview: updateGroupPreview(updateGroupContract),
  auditTarget: groupAuditTarget,
});
