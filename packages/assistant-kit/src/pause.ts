/**
 * The pause and what it takes to leave it.
 *
 * The record stores the **continuation** — the exact provider messages of the
 * turn plus the tool call that stopped — so resume replays them instead of
 * re-deriving a conversation from persisted rows. Re-derivation has to guess
 * ids, merge results and stage identifiers, and each guess is a place to be
 * wrong.
 */
import type { ModelMessage } from "ai";
import { z } from "zod";

import {
  conversationIdSchema,
  interactionIdSchema,
  providerToolCallIdSchema,
  revisionSchema,
} from "./ids.js";

export const pauseStatusSchema = z.enum([
  "open",
  "claimed",
  "answered",
  "cancelled",
  "expired",
]);
export type PauseStatus = z.output<typeof pauseStatusSchema>;

/**
 * Sent back to the model unchanged. `pausedToolCall.id` is the id the provider
 * itself issued, so no boundary rewrite is needed or permitted.
 */
export interface Continuation {
  readonly messages: readonly ModelMessage[];
  readonly pausedToolCall: {
    readonly id: z.output<typeof providerToolCallIdSchema>;
    readonly name: string;
  };
}

/**
 * Server-side record. `secret` never appears on the wire: the public view
 * below has no field able to hold it, so leaking it is a type error rather
 * than a review catch.
 */
export interface PauseRecord {
  /** A registered interaction kind. */
  readonly kind: string;
  /**
   * Opaque owner token supplied by the caller — typically identity plus
   * tenant. Never interpreted, only matched exactly. A mismatch is reported
   * as `gone`, indistinguishable from "no such pause", so probing another
   * owner's conversation teaches nothing.
   */
  readonly bind: string;
  readonly interactionId: string;
  readonly revision: number;
  readonly conversationId: string;
  readonly status: PauseStatus;
  readonly continuation: Continuation;
  /** Public payload, already validated against the kind's `prompt` schema. */
  readonly prompt: unknown;
  /** Private payload. Round-tripped as JSON, never parsed by this package. */
  readonly secret: unknown;
  readonly expiresAt: string;
}

/** Everything a client may see. Deliberately not derived from `PauseRecord`. */
export const publicPauseSchema = z.strictObject({
  kind: z.string().min(1),
  interactionId: interactionIdSchema,
  revision: revisionSchema,
  status: pauseStatusSchema,
  prompt: z.unknown(),
  expiresAt: z.string().min(1),
});

export type PublicPause = z.output<typeof publicPauseSchema>;

/** Who is asking. Every read and write of a pause is scoped by it. */
export interface PauseScope {
  readonly conversationId: string;
  readonly bind: string;
}

/**
 * The envelope a client sends. The answer body itself is validated by the
 * kind's own schema, so nothing here enumerates what an answer may be.
 */
export const interactionResponseSchema = z.strictObject({
  commandId: z.uuid(),
  conversationId: conversationIdSchema,
  interactionId: interactionIdSchema,
  revision: revisionSchema,
  answer: z.unknown(),
});

export type InteractionResponse = z.output<typeof interactionResponseSchema>;

/**
 * A claim consumes one (interactionId, revision) exactly once.
 *
 * `stale` means the subject of the decision changed while the card was on
 * screen: the answer is refused and the caller shows the current pause, never
 * silently applying it to a different draft. `invalid_answer` and
 * `unresolvable` are both decided **before** the claim is consumed, so a
 * malformed or meaningless answer leaves the pause answerable.
 */
export type ClaimResult =
  | {
      readonly kind: "claimed";
      readonly record: PauseRecord;
      /** What the kind's `resolve` made of the answer. */
      readonly value: unknown;
    }
  | { readonly kind: "stale"; readonly current: PublicPause }
  | { readonly kind: "gone" }
  | { readonly kind: "expired" }
  | { readonly kind: "unknown_kind"; readonly kindName: string }
  | { readonly kind: "invalid_answer"; readonly reason: string }
  | { readonly kind: "unresolvable"; readonly reason: string };

/** What the caller feeds back into the model. No reconstruction. */
export interface ResumeInput {
  readonly messages: readonly ModelMessage[];
}
