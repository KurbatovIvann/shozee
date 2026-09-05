import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { z } from "zod";

import { updateStaffLegal } from "../services/update-legal.js";
import { updateLegalContract } from "./update-legal.contract.js";

const companyIdHolder = z.object({ id: z.string() });

function updateLegalAuditTarget(env: AuditTargetEnv): {
  type: string;
  id: string;
} {
  const fromOutput = companyIdHolder.safeParse(env.output);
  return {
    type: "company",
    id: fromOutput.success ? fromOutput.data.id : "uncreated",
  };
}

export const updateLegal = implementAction(updateLegalContract, {
  handler: (input, ctx) => {
    return updateStaffLegal({ ctx, input });
  },
  auditTarget: updateLegalAuditTarget,
});
