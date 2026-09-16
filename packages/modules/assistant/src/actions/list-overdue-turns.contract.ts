import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { OVERDUE_TURNS_BATCH_MAX } from "./sweep-overdue-turns.contract.js";
import { assistantTurnRefShape } from "./turn-record.contract.js";

export const overdueTurnSchema = z.strictObject({
  companyId: z.uuid(),
  ...assistantTurnRefShape,
});

export const listOverdueTurnsInputSchema = z.strictObject({
  limit: z.int().min(1).max(OVERDUE_TURNS_BATCH_MAX),
  after: overdueTurnSchema.optional(),
});

export const listOverdueTurnsOutputSchema = z.strictObject({
  turns: z.array(overdueTurnSchema),
  next: overdueTurnSchema.nullable(),
});

export const listOverdueTurnsContract = defineActionContract({
  name: "assistant.listOverdueTurns",
  description:
    "List staff assistant turns across companies that are overdue: queued and past their start deadline, or running past their own deadline. Ordered by company, conversation, kind and command, at most limit, strictly after the given turn identity. Each turn carries only its company and its identity; no status, hold, placeholder, message content, person or session. next is the last identity of a full page, to continue after, or null when the page is not full.",
  principal: "system",
  systemScope: "global",
  transport: "internal",
  input: listOverdueTurnsInputSchema,
  output: listOverdueTurnsOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 10_000,
});
