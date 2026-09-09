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

import type { ChatDocument, DocumentWrite } from "./document.js";
import type {
  InteractionRegistry,
  InteractionType,
} from "./interaction.js";
import type { Continuation } from "./pause.js";
import type { KitDeps } from "./ports.js";
import type { ClaimResult, PauseScope, PublicPause, ResumeInput } from "./pause.js";

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

export interface AssistantKit<T extends AnyTypes> {
  readonly interactions: InteractionRegistry<T>;

  /**
   * Store the pause. Called before the turn returns, so an answer arriving
   * immediately after the response finds it.
   */
  open(input: OpenPauseInput<T>): Promise<OpenPauseResult>;

  /** Read-only. Safe to call on every document read. */
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

  readonly document: {
    read(scope: PauseScope): Promise<ChatDocument>;
    write(conversationId: string, write: DocumentWrite): Promise<void>;
  };
}

/** Wired by the consumer in its composition root. */
export { createAssistantKit } from "./create-kit.js";

export type { KitDeps };
