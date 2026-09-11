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
 *   accept (SHO-570). Such a turn would otherwise hold its conversation and its
 *   hold for ever. Age alone is not proof that it cannot start — a deep enough
 *   backlog ages a healthy turn past any threshold — so the caller asks this
 *   only for a turn whose job the queue no longer holds; see the threshold's
 *   own note. `startTurn` is a compare-and-set on `queued` too, so exactly one
 *   of a start and this interrupt wins.
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
 * How long a queued turn that has **no job** may stay queued before the
 * reconciler ends it (SHO-570, ADR-0039 as amended).
 *
 * Age alone does not mean abandoned, and this threshold must not be read as if
 * it did. At the declared starting values one worker runs 4 turns at once, each
 * up to 180 s, so it drains about 1.33 turns a minute at worst: a backlog of
 * roughly twenty turns puts a perfectly healthy queued turn past fifteen
 * minutes. What separates the two is the job. A backlogged turn has one
 * waiting, however deep the queue; a turn that can never start has none,
 * because its job completed and was removed (`removeOnComplete`) after being
 * refused at start. The caller checks that — this statement decides only the
 * age — and a caller can therefore only narrow what is ended here, never widen
 * it.
 *
 * Fifteen minutes is then the bound on how long such a turn holds its author's
 * conversation and its reservation. A policy value, changed with a proving test.
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
