/**
 * System read: the turns the reconciler has to act on (SHO-560, ADR-0039).
 *
 * Global system scope, and safe as such:
 *
 * - it is `transport: "internal"` and `aiExposure: "internal"`, so no client and
 *   no model can reach it; only a system context built by the maintenance
 *   scheduler can;
 * - it is a read, and it returns only what re-enqueueing or interrupting needs —
 *   the turn's identity, its company and its placeholder. Not its budget hold:
 *   the statement that ends a turn zeroes that hold and hands it back, and a
 *   copy read here would be a second answer to "what does this turn hold"
 *   (SHO-570). No message content, no person, no session, no request id;
 * - the reconciler exists because a crashed worker leaves no request and no
 *   caller behind: the turns it looks for belong to every company at once, and
 *   the company each belongs to comes from the row, never from input.
 *
 * Staleness is decided by Postgres `now()` against times Postgres set, so a
 * process whose clock drifts cannot misjudge it.
 *
 * Mechanical: `timeout: 10000` is one bounded scan of the active turns.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  assistantTurnKindSchema,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

/** The most stale turns one read returns; the next tick takes the rest. */
export const STALE_TURNS_PAGE_MAX = 100;

export const listStaleTurnsInputSchema = z.strictObject({
  /** A queued turn older than this, and never started, has lost its job. */
  queuedStaleAfterMs: z
    .int()
    .min(1_000)
    .max(60 * 60 * 1000),
  limit: z.int().min(1).max(STALE_TURNS_PAGE_MAX),
});

export const staleTurnSchema = z.strictObject({
  companyId: z.uuid(),
  conversationId: z.uuid(),
  kind: assistantTurnKindSchema,
  commandId: z.uuid(),
  status: assistantTurnStatusSchema,
  placeholderMessageId: z.uuid(),
  /**
   * What the reconciler does with it, decided by the same predicates
   * `assistant.interruptTurn` ends a turn by: re-enqueue a
   * `queued_without_start`, interrupt the other two.
   */
  staleness: z.enum([
    "queued_without_start",
    "queued_abandoned",
    "running_past_deadline",
  ]),
});

export const listStaleTurnsOutputSchema = z.strictObject({
  turns: z.array(staleTurnSchema),
});

export const listStaleTurnsContract = defineActionContract({
  name: "assistant.listStaleTurns",
  description:
    "List staff assistant turns across companies that the reconciler has to act on: turns still queued and never started longer than queuedStaleAfterMs after they were accepted (queued_without_start), turns queued past the abandon threshold (queued_abandoned), and running turns past their deadline (running_past_deadline). Oldest first, at most limit. Each turn carries its company, conversation, kind, command and placeholder message; no budget hold, message content, person or session.",
  principal: "system",
  systemScope: "global",
  transport: "internal",
  input: listStaleTurnsInputSchema,
  output: listStaleTurnsOutputSchema,
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
