import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { changeLines } from "@showzy/module-kit/preview-changes";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import { z } from "zod";

import {
  legalPreviewLines,
  legalPreviewNotes,
  loadStoredLegalFacts,
} from "../services/preview-legal.js";
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
  preview: async (input, env) => {
    const stored = await loadStoredLegalFacts({
      tx: env.tx,
      companyId: previewCompanyScope(env.companyId, updateLegalContract),
    });
    return {
      title: "Зберегти реквізити компанії",
      lines: changeLines(legalPreviewLines(input, stored)),
      notes: legalPreviewNotes(input, stored),
    };
  },
  auditTarget: updateLegalAuditTarget,
});
