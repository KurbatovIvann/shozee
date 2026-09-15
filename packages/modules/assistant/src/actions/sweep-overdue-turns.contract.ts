import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { OVERDUE_TURNS_PAGE_MAX } from "./list-overdue-turns.contract.js";
import {
  assistantTurnActiveStatusSchema,
  assistantTurnBudgetHoldSchema,
  assistantTurnEndReasonSchema,
  assistantTurnRefShape,
} from "./turn-record.contract.js";

export const sweepOverdueTurnsInputSchema = z.strictObject({
  turns: z
    .array(z.strictObject({ ...assistantTurnRefShape }))
    .max(OVERDUE_TURNS_PAGE_MAX),
});

export const sweptTurnSchema = z.strictObject({
  ...assistantTurnRefShape,
  placeholderMessageId: z.uuid(),
  from: assistantTurnActiveStatusSchema,
  endReason: assistantTurnEndReasonSchema,
  releasedHold: assistantTurnBudgetHoldSchema,
});

export const sweepOverdueTurnsOutputSchema = z.strictObject({
  ended: z.array(sweptTurnSchema),
});

export const sweepOverdueTurnsContract = defineActionContract({
  name: "assistant.sweepOverdueTurns",
  description:
    "Interrupt the given staff assistant turns of this company that are still overdue: a queued turn past its start deadline ends with end reason not_started, a running turn past its deadline with timeout. Each ended turn stops holding its conversation and gives up the budget hold it stored; the result lists exactly the turns this call ended, with placeholder, prior status, end reason and the hold it took. A turn that has since started, ended or is no longer overdue is left as it is and not listed. Every given turn must belong to this company, or nothing is ended and the call is not-found. An empty list ends nothing. Company id is never input.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: sweepOverdueTurnsInputSchema,
  output: sweepOverdueTurnsOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 10_000,
});
