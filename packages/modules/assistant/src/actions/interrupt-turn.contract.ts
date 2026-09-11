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
 * Compare-and-set, in one statement, to `interrupted` from one of two states,
 * each judged by Postgres `now()` against a time Postgres set: the same
 * statement zeroes the hold the row stored and returns what it zeroed.
 *
 * - `running` past its deadline. A server-side timeout is the only thing that
 *   ends a started turn early.
 * - `queued` and not started within `ASSISTANT_QUEUED_TURN_ABANDON_MS` of its
 *   accept (SHO-570). Such a turn can never start — its author lost membership,
 *   or its job is refused every time — and would otherwise hold its
 *   conversation and its hold forever. `startTurn` is a compare-and-set on
 *   `queued` too, so exactly one of a start and this interrupt wins.
 *
 * `from` says which: the turn's status when this statement ended it. A queued
 * turn never reached the model, so its hold is the caller's to release; a
 * running one may have, so its hold stands as the charge.
 *
 * Every other active turn — queued inside the threshold, running inside its
 * deadline — is left as it is and reported as `not_stale`. A turn that already
 * ended keeps its status and is reported as `already_finished`. Neither hands
 * out a hold, so each hold is handed out at most once.
 *
 * `idempotent: false`: the compare-and-set is the idempotency. A replay store
 * would hand the first call's hold to a retry, and it would be released twice.
 *
 * Mechanical: `timeout: 5000` is one update by unique key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  assistantTurnActiveStatusSchema,
  assistantTurnBudgetHoldSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

/**
 * How long an accepted turn may stay queued before the reconciler ends it
 * (SHO-570, ADR-0039 as amended). A worker picks a job up in well under a
 * second, and the reconciler re-enqueues a lost one within a minute or two; a
 * turn still queued after fifteen minutes is not waiting, it cannot start.
 * A policy value, changed with a proving test.
 */
export const ASSISTANT_QUEUED_TURN_ABANDON_MS = 15 * 60 * 1000;

export const interruptTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
});

export const interruptTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("interrupted"),
    conversationId: z.uuid(),
    /** The status this call ended the turn from. */
    from: assistantTurnActiveStatusSchema,
    /** The hold this call took off the row; the caller settles or releases it. */
    releasedHold: assistantTurnBudgetHoldSchema,
  }),
  z.strictObject({
    outcome: z.literal("not_stale"),
    conversationId: z.uuid(),
    status: assistantTurnActiveStatusSchema,
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
    "Interrupt a staff assistant turn of this company, named by its conversation, kind and command, that is running past its deadline or has stayed queued, never started, for longer than the abandon threshold: it becomes interrupted, stops holding its conversation, and gives up the budget hold it stored, which is returned with the status it was ended from. Any other queued or running turn is left as it is and reported as not_stale with its status. A turn that already ended keeps its status and reports it as already_finished. Neither returns a hold. A turn that does not exist in this company is not-found. Company id is never input.",
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
