/**
 * The pause and what it takes to leave it.
 *
 * The record stores the **continuation** — the exact provider messages of the
 * turn plus the tool call that stopped — so resume replays them instead of
 * re-deriving a conversation from persisted rows. Re-derivation is the
 * mechanism that produced the resume defects: it must guess ids, merge tool
 * results, and stage execution ids, and each guess is a place to be wrong.
 */
import type { ModelMessage } from "ai";
import { z } from "zod";

import {
  conversationIdSchema,
  interactionIdSchema,
  providerToolCallIdSchema,
  revisionSchema,
} from "./ids.js";
import { choiceOptionSchema } from "./outcome.js";

export const PAUSE_KINDS = ["choice", "confirmation"] as const;
export type PauseKind = (typeof PAUSE_KINDS)[number];

export const pauseStatusSchema = z.enum([
  "open",
  "claimed",
  "answered",
  "cancelled",
  "expired",
]);
export type PauseStatus = z.output<typeof pauseStatusSchema>;

/**
 * Sent back to `streamText` unchanged. `messages` is what was already sent
 * this turn; `pausedToolCall.id` is the id the provider itself issued, so no
 * boundary rewrite is needed or permitted.
 */
export interface Continuation {
  readonly messages: readonly ModelMessage[];
  readonly pausedToolCall: {
    readonly id: z.output<typeof providerToolCallIdSchema>;
    readonly name: string;
  };
}

/**
 * Server-side record. `resolvedInput` and `optionMap` are secrets: the wire
 * type below has no field that can hold them, so leaking one is a type error
 * rather than a review catch.
 */
export interface PauseRecord<TInput> {
  readonly kind: PauseKind;
  /**
   * Opaque owner token supplied by the caller — typically actor plus tenant.
   * The kit never interprets it; it only requires an exact match. A mismatch
   * is reported as `gone`, indistinguishable from "no such pause", so probing
   * another owner's conversation teaches nothing.
   */
  readonly bind: string;
  readonly interactionId: string;
  readonly revision: number;
  readonly conversationId: string;
  readonly status: PauseStatus;
  readonly continuation: Continuation;
  readonly resolvedInput: TInput;
  /** optionId -> domain entity id. The client sends only optionId. */
  readonly optionMap: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly options: readonly z.output<typeof choiceOptionSchema>[];
  readonly optionsTruncated: boolean;
  readonly summary?: string;
  readonly challengeRef?: string;
  readonly expiresAt: string;
}

/** Everything the client may see. Deliberately not derived from PauseRecord. */
export const publicPauseSchema = z.strictObject({
  kind: z.enum(PAUSE_KINDS),
  interactionId: interactionIdSchema,
  revision: revisionSchema,
  status: pauseStatusSchema,
  subject: z.string().min(1),
  summary: z.string().min(1).optional(),
  options: z.array(
    choiceOptionSchema.omit({ entityId: true }).extend({
      optionId: z.string().min(1),
    }),
  ),
  optionsTruncated: z.boolean(),
  expiresAt: z.string().min(1),
});

export type PublicPause = z.output<typeof publicPauseSchema>;

/** The human's answer. The client may not name a tool, an input, or a route. */
export const answerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("select"), optionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("approve") }),
  z.strictObject({ kind: z.literal("reject") }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
]);

export type Answer = z.output<typeof answerSchema>;
export type AnswerKind = Answer["kind"];

export const interactionResponseSchema = z.strictObject({
  commandId: z.uuid(),
  conversationId: conversationIdSchema,
  interactionId: interactionIdSchema,
  revision: revisionSchema,
  answer: answerSchema,
});

export type InteractionResponse = z.output<typeof interactionResponseSchema>;

/**
 * A claim consumes one (interactionId, revision) exactly once. `stale` means
 * the subject of the decision changed while the card was on screen — the
 * answer is refused and the caller shows the current pause, it is never
 * silently applied to a different draft.
 */
/** Who is asking. Every read and write of a pause is scoped by it. */
export interface PauseScope {
  readonly conversationId: string;
  readonly bind: string;
}

export type ClaimResult<TInput> =
  | { readonly kind: "claimed"; readonly record: PauseRecord<TInput> }
  | { readonly kind: "stale"; readonly current: PublicPause }
  | { readonly kind: "gone" }
  | { readonly kind: "expired" }
  | {
      readonly kind: "wrong_answer_kind";
      readonly expected: readonly AnswerKind[];
    };

/**
 * What the caller feeds back into `streamText`.
 *
 * The stored continuation already ends with a tool-result for the paused
 * call — the pausing tool returned, so the SDK recorded its output. Resume
 * therefore **replaces** that one output with the resolved one. Appending a
 * second result for the same `toolCallId` would be history no provider
 * accepts, and trimming the message would make resume a reconstruction again.
 *
 * The invariant: identical to the stored continuation except exactly one
 * `output`. Nothing added, removed or re-ordered.
 */
export interface ResumeInput {
  readonly messages: readonly ModelMessage[];
}
