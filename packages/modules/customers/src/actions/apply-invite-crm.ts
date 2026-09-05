import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { z } from "zod";

import { applyInviteCrmContract } from "./apply-invite-crm.contract.js";
import {
  applyInviteCrmRecord,
  resolveApplyInviteCrmCompany,
} from "../services/apply-invite-crm.js";

const customerIdHolder = z.object({ customerId: z.string() });

export const applyInviteCrm = implementAction(applyInviteCrmContract, {
  resolveTarget: async (input, env) => {
    if (env.principal.mode !== "customer") {
      throw new NotFoundError();
    }
    return resolveApplyInviteCrmCompany(input, env);
  },
  handler: (input, ctx) => {
    return applyInviteCrmRecord({ ctx, input });
  },
  auditTarget: (env) => {
    const fromOutput = customerIdHolder.safeParse(env.output);
    return {
      type: "customer",
      id: fromOutput.success ? fromOutput.data.customerId : "uncreated",
    };
  },
});
