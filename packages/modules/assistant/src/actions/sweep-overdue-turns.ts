import { implementAction } from "@showzy/core";
import { createAuditTarget } from "@showzy/module-kit/audit-target";

import { sweepSystemOverdueTurns } from "../services/turns.js";
import { sweepOverdueTurnsContract } from "./sweep-overdue-turns.contract.js";

export const sweepOverdueTurns = implementAction(sweepOverdueTurnsContract, {
  handler: (input, ctx) => sweepSystemOverdueTurns({ ctx, input }),
  auditTarget: createAuditTarget({
    type: "assistant_turns",
    fallback: "overdue",
    steps: [],
  }),
});
