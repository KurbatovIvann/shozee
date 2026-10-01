import { implementAction } from "@showzy/core";
import { createStaffGroup } from "../services/create-group.js";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { createGroupPreview } from "../services/preview-card.js";
import { createGroupContract } from "./create-group.contract.js";

export const createGroup = implementAction(createGroupContract, {
  handler: (input, ctx) => {
    return createStaffGroup({ ctx, input });
  },
  preview: createGroupPreview(createGroupContract),
  auditTarget: groupAuditTarget,
});
