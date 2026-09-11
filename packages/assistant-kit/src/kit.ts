/**
 * The public surface.
 *
 * Scope, stated so it can be checked rather than remembered. This package does
 * not: call a model, mount HTTP, own storage, render UI, hold a tool registry,
 * run a queue — or know what kinds of interaction exist. Kinds come from the
 * caller's registry, so the union of kinds is derived and a mistyped kind is a
 * type error.
 */
import type { z } from "zod";

import type { ChatWindow, MessageWrite } from "./messages.js";
import type { InteractionRegistry, InteractionType } from "./interaction.js";
import type { Continuation } from "./pause.js";
import type { KitDeps } from "./ports.js";
import type {
  ClaimResult,
  PauseScope,
  PublicPause,
  ResumeInput,
} from "./pause.js";

type AnyTypes = Record<string, InteractionType<z.ZodType, z.ZodType, never>>;

export interface OpenPauseInput<T extends AnyTypes> {
  readonly conversationId: string;
  /** Opaque owner token. See `PauseRecord.bind`. */
  readonly bind: string;
  readonly kind: keyof T & string;
  /** Validated against the kind's `prompt` schema. */
  readonly prompt: unknown;
  /** Never leaves the server. */
  readonly secret: unknown;
  readonly continuation: Continuation;
}

export type OpenPauseResult =
  | { readonly kind: "opened"; readonly pause: PublicPause }
  /** One open interaction per conversation. The caller decides: replace or refuse. */
  | { readonly kind: "already_open"; readonly current: PublicPause }
  | { readonly kind: "unknown_kind"; readonly kindName: string }
  | { readonly kind: "invalid_prompt"; readonly reason: string };

export type RevisePauseResult = OpenPauseResult | { readonly kind: "gone" };

/**
 * How long a turn may hold its conversation before the lease lapses.
 *
 * Chosen against the two ways it can be wrong. Too short and a slow turn loses
 * the lock while it is still writing, which is the defect the lock exists to
 * prevent. Too long and a process that died holding one leaves the person
 * unable to say anything for that whole time. Losing writes is silent and
 * losing time is not, so this errs long — and `end` reports a lease that had
 * already lapsed, so the case is visible rather than guessed at.
 */
export const TURN_LEASE_MS = 120_000;

export type BeginTurnResult =
  | {
      readonly kind: "began";
      /**
       * Proof of this holder. Passed back to `end`, so a turn whose lease has
       * lapsed cannot release the lock a later turn now holds.
       */
      readonly token: string;
    }
  | { readonly kind: "busy" };

export interface AssistantKit<T extends AnyTypes> {
  readonly interactions: InteractionRegistry<T>;

  /**
   * Store the pause. Called before the turn returns, so an answer arriving
   * immediately after the response finds it.
   */
  open(input: OpenPauseInput<T>): Promise<OpenPauseResult>;

  /** Read-only. Safe to call on every read. */
  peek(scope: PauseScope): Promise<PublicPause | null>;

  /**
   * Consume one (interactionId, revision) exactly once. Concurrent callers:
   * one gets `claimed`, the rest get `gone`. A malformed or meaningless answer
   * is refused without consuming anything.
   */
  claim(
    input: PauseScope & {
      readonly interactionId: string;
      readonly revision: number;
      /** Untrusted. Parsed by the kind's own `answer` schema. */
      readonly answer: unknown;
    },
  ): Promise<ClaimResult>;

  /**
   * Turn a claim into the exact provider payload. Pure: no I/O, no clock.
   *
   * The stored continuation already ends with a tool-result for the paused
   * call — the pausing tool returned, so the model saw its output. This
   * **replaces** that one output with the resolved one. Appending a second
   * result for the same call would be history no provider accepts, and
   * trimming the message would make resume a reconstruction again.
   */
  resume(
    claimed: Extract<ClaimResult, { kind: "claimed" }>,
    output: unknown,
  ): ResumeInput;

  /** Raise the revision when the subject of the decision changes. */
  revise(
    input: PauseScope & {
      readonly interactionId: string;
      readonly next: Omit<OpenPauseInput<T>, "conversationId" | "bind">;
    },
  ): Promise<RevisePauseResult>;

  abandon(
    input: PauseScope & { readonly interactionId: string },
  ): Promise<{ readonly kind: "cancelled" | "gone" }>;

  /**
   * Make a claimed pause answerable again, at the same revision.
   *
   * For the case where the answer was accepted but the action it authorised
   * had no effect. The caller asserts the absence of effect; this package
   * cannot know it. Do not call it after a write that may have committed —
   * an idempotency key, not this, is what makes a retry safe.
   */
  release(
    input: PauseScope & { readonly interactionId: string },
  ): Promise<{ readonly kind: "released" | "gone" }>;

  /**
   * One turn at a time, per conversation.
   *
   * Two turns on one conversation — two devices, two tabs, a retry that outran
   * its own reply — interleave their messages, and the second turn's model
   * answers a conversation that no longer exists as it read it. Nothing else
   * here prevents that: `busy` in a client is per client, and the serial tool
   * chain inside a turn is per turn. The log refuses the storage half — a write
   * reaches only the latest message, so a turn whose lease lapsed fails its next
   * write instead of landing out of order — but it cannot make two
   * conversations into one.
   *
   * A lease rather than a queue. Two people talking to one conversation at once
   * is not work to be ordered, so the second is refused, and told, rather than
   * run late.
   */
  readonly turn: {
    begin(
      scope: PauseScope,
      options?: { readonly ttlMs?: number },
    ): Promise<BeginTurnResult>;
    /** False when the lease had already lapsed — the caller should say so. */
    end(scope: PauseScope, token: string): Promise<boolean>;
  };

  readonly messages: {
    /**
     * The latest window of the conversation, or the page before `before` — a
     * cursor an earlier read returned as `olderCursor`. Check a cursor that
     * came from outside with `chatCursorSchema` first; an invalid one throws.
     */
    read(
      scope: PauseScope,
      options?: { readonly before?: string },
    ): Promise<ChatWindow>;
    /**
     * Scoped like the read. A write under a `bind` other than the one the log
     * was written under is refused — `wrong_owner` — rather than silently
     * appended to someone else's conversation.
     *
     * Only the latest message can change. A write naming it merges into it;
     * any other message id starts a new one, and an id the log already holds
     * further back is refused by the store.
     *
     * `unchanged`: an `end_text` found nothing to end. `conflict`: other writes
     * kept changing the message for every attempt this write made, and nothing
     * was stored.
     */
    write(
      scope: PauseScope,
      write: MessageWrite,
    ): Promise<{
      readonly kind: "written" | "unchanged" | "wrong_owner" | "conflict";
    }>;
  };
}

/** Wired by the consumer in its composition root. */
export { createAssistantKit } from "./create-kit.js";

export type { KitDeps };
