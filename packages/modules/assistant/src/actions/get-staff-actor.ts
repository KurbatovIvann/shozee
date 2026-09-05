import { implementAction } from "@showzy/core";
import { getStaffActorContract } from "./get-staff-actor.contract.js";

export const getStaffActor = implementAction(getStaffActorContract, {
  handler: (_input, ctx) => {
    return Promise.resolve({
      role: ctx.membership.role,
      permissions: [...ctx.membership.permissions],
    });
  },
});
