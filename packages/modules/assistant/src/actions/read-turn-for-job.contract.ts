/**
 * System read: the one turn a queued job names (SHO-561, ADR-0039).
 *
 * The job carries only the turn's identity — kind, conversation and command —
 * so the worker reads everything else here: whom the turn acts as, in which
 * company, under which request, into which placeholder, with which budget hold
 * and under which command its tools derive their keys.
 *
 * Global system scope, and safe as such:
 *
 * - `transport: "internal"` and `aiExposure: "internal"`: no client and no model
 *   can reach it, only a system context the worker builds;
 * - a job is not a principal. The company and the actor come from the row the
 *   accept wrote under its verified staff context, never from the job, and the
 *   actor's membership is checked again by core on every action the turn then
 *   runs as that person;
 * - it is a read, of one row, by its unique identity.
 *
 * The session is not read and not returned: the actor is `user_id`, and a turn
 * accepted before its author signed out may still finish (ADR-0039, amended
 * 2026-09-11).
 *
 * Mechanical: `timeout: 5000` is one indexed read.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  assistantTurnBudgetHoldSchema,
  assistantTurnKindSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const readTurnForJobInputSchema = z.strictObject({
  ...assistantTurnRefShape,
});

export const turnForJobSchema = z.strictObject({
  companyId: z.uuid(),
  conversationId: z.uuid(),
  kind: assistantTurnKindSchema,
  commandId: z.uuid(),
  /** The staff member the turn acts as, from the accept's verified context. */
  userId: z.string().min(1),
  /** The request the turn's actions are audited under. */
  requestId: z.string().min(1),
  status: assistantTurnStatusSchema,
  placeholderMessageId: z.uuid(),
  /** Set when the turn started; null while it is queued. */
  deadlineAt: z.iso.datetime({ offset: true }).nullable(),
  /** What the row still holds: zero once the turn has been finalised. */
  budgetHold: assistantTurnBudgetHoldSchema,
  /**
   * The command this turn's tools derive their idempotency keys from: the
   * first turn of a continuation chain, or the turn's own command.
   */
  continuationRootCommandId: z.uuid(),
});

export const readTurnForJobOutputSchema = z.strictObject({
  turn: turnForJobSchema.nullable(),
});

export const readTurnForJobContract = defineActionContract({
  name: "assistant.readTurnForJob",
  description:
    "Read the staff assistant turn a queued job names by its conversation, kind and command, in any casing, across companies. Returns the turn's company, conversation, kind, command, the staff user it acts as, the request id its actions are audited under, its status, placeholder message, deadline, the budget hold the row still holds, and the command its tools derive idempotency keys from; or null when no such turn exists. No message content and no session. Company id is never input.",
  principal: "system",
  systemScope: "global",
  transport: "internal",
  input: readTurnForJobInputSchema,
  output: readTurnForJobOutputSchema,
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
  timeout: 5_000,
});
