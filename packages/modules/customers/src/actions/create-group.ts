import { implementAction } from "@showzy/core";
import { createStaffGroup } from "../services/create-group.js";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { createGroupContract } from "./create-group.contract.js";

export const createGroup = implementAction(createGroupContract, {
  handler: (input, ctx) => {
    return createStaffGroup({ ctx, input });
  },
  auditTarget: groupAuditTarget,
});
