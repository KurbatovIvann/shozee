/**
 * System write: interrupt a turn a crashed worker left behind (SHO-561,
 * ADR-0039).
 *
 * The reconciler's write. It changes turn-status protocol state the assistant
 * module owns — the lease and the stored budget hold of one `assistant_turns`
 * row — and no domain content: no message, no card, no history.
 *
 * Tenant system scope: the reconciler finds a stale turn with its company
 * (`assistant.listStaleTurns`) and interrupts it inside that company, so the
 * write cannot reach another company's turn and its audit row carries the
 * company.
 *
 * Compare-and-set, in one statement, from an active status to `interrupted`:
 * the same statement zeroes the hold the row stored and returns what it zeroed.
 * A turn that already ended — finished by its worker, or interrupted before —
 * keeps its status and reports it as `already_finished` with no hold, so each
 * hold is handed out at most once.
 *
 * `idempotent: false`: the compare-and-set is the idempotency. A replay store
 * would hand the first call's hold to a retry, and it would be released twice.
 *
 * Mechanical: `timeout: 5000` is one update by unique key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  assistantTurnBudgetHoldSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const interruptTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
});

export const interruptTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("interrupted"),
    conversationId: z.uuid(),
    /** The hold this call took off the row; the caller settles or releases it. */
    releasedHold: assistantTurnBudgetHoldSchema,
  }),
  z.strictObject({
    outcome: z.literal("already_finished"),
    conversationId: z.uuid(),
    status: assistantTurnStatusSchema,
  }),
]);

export const interruptTurnContract = defineActionContract({
  name: "assistant.interruptTurn",
  description:
    "Interrupt a staff assistant turn of this company, named by its conversation, kind and command: a queued or running turn becomes interrupted, stops holding its conversation, and gives up the budget hold it stored, which is returned. A turn that already ended keeps its status and reports it as already_finished with no hold. A turn that does not exist in this company is not-found. Company id is never input.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: interruptTurnInputSchema,
  output: interruptTurnOutputSchema,
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
  timeout: 5_000,
});
