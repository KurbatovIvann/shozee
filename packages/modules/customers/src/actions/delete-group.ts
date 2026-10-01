import { implementAction } from "@showzy/core";
import { deleteStaffGroup } from "../services/delete-group.js";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { deleteGroupPreview } from "../services/preview-card.js";
import { deleteGroupContract } from "./delete-group.contract.js";

export const deleteGroup = implementAction(deleteGroupContract, {
  handler: (input, ctx) => {
    return deleteStaffGroup({ ctx, input });
  },
  preview: deleteGroupPreview(deleteGroupContract),
  auditTarget: groupAuditTarget,
});
