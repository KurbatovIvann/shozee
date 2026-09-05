import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { z } from "zod";

import { createOwnedCompany } from "../services/create-company.js";
import { createCompanyContract } from "./create.contract.js";

const companyIdHolder = z.object({ company: z.object({ id: z.string() }) });

function createAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const fromOutput = companyIdHolder.safeParse(env.output);
  return {
    type: "company",
    id: fromOutput.success ? fromOutput.data.company.id : "uncreated",
  };
}

export const createCompany = implementAction(createCompanyContract, {
  handler: (input, ctx) => {
    return createOwnedCompany({ ctx, input });
  },
  auditTarget: createAuditTarget,
});
