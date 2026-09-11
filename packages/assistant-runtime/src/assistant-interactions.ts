/**
 * The kinds of question this product asks, and what a valid answer to each
 * looks like.
 *
 * This is the half `@showzy/assistant-kit` deliberately does not have. The
 * package owns the mechanism — claim once, refuse a stale revision, replay the
 * continuation — and knows nothing about pickers, confirmations, option caps or
 * entity ids.
 *
 * Of that product knowledge, the part a client also needs — the prompt shapes
 * and the picker cap — is declared in `@showzy/validation/assistant-chat` and
 * imported below, so a question has one definition rather than one per renderer.
 * What stays here is what a client must never see: deadlines, secrets, and how
 * an answer resolves into a real call.
 */
import {
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
} from "@showzy/assistant-kit";
import { CONFIRMATION_TTL_MS as CHALLENGE_TTL_MS } from "@showzy/core";
import {
  assistantChoicePromptSchema,
  assistantConfirmationPromptSchema,
} from "@showzy/validation/assistant-chat";
import { z } from "zod";

/** Deliberately longer than a confirmation: "which one" waits better than
 * "are you sure". */
export const CHOICE_TTL_MS = 15 * 60 * 1000;
/**
 * Core's challenge lifetime, read rather than restated, so the two cannot
 * drift. The pause opens when the turn ends, after the challenge was issued, so
 * it outlives the challenge by the turn's length; a tap in that gap gets a fresh
 * challenge and a new card, never an execution.
 */
export const CONFIRMATION_TTL_MS = CHALLENGE_TTL_MS;

/**
 * Where the chosen id belongs once the ambiguity is settled. Mirrors what the
 * domain reports on a picker CONFLICT.
 */
export type ChoicePickerTarget =
  | { readonly kind: "customer"; readonly query: string }
  | {
      readonly kind: "order_line_product";
      readonly lineIndex: number;
      readonly query: string;
    }
  | {
      // Optional in the domain's own report, so it must accept an explicit
      // undefined here too.
      readonly kind?: "order_line_variant" | undefined;
      readonly lineIndex: number;
      readonly productId: string;
      readonly productName: string;
    };

/**
 * Server-side only. `byOption` never reaches a client — the client sends an
 * `optionId` and the server says what it meant.
 *
 * `input` is the tool's own input, not the domain's canonical form. Replaying
 * at that level means resolving an ambiguity is "call the same tool again with
 * one field filled in", with no second code path that has to agree with the
 * first.
 */
export interface ChoiceSecret {
  readonly byOption: Record<string, string>;
  readonly toolName: string;
  readonly input: unknown;
  readonly target: ChoicePickerTarget;
}

/**
 * Server-side only: what core bound the challenge to, which a resume presents
 * again unchanged. The idempotency key above all — it is the attempt's identity,
 * and a resume under any other key is a different attempt that core answers with
 * a fresh challenge instead of running.
 */
export interface ConfirmationSecret {
  readonly actionName: string;
  /** The object `executeAction` received. Core hashed it. */
  readonly canonicalInput: unknown;
  readonly idempotencyKey: string;
  readonly challengeId: string;
}

export interface ChoiceResolution {
  readonly entityId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly target: ChoicePickerTarget;
}

/**
 * Names the attempt a person approved. It authorises nothing by itself: core
 * decides whether the challenge still holds for that attempt (SHO-553).
 */
export interface ConfirmationResolution {
  readonly approved: true;
  readonly actionName: string;
  readonly canonicalInput: unknown;
  readonly idempotencyKey: string;
  readonly challengeId: string;
}

export const choice = defineInteraction<ChoiceSecret>()({
  ttlMs: CHOICE_TTL_MS,
  prompt: assistantChoicePromptSchema,
  answer: z.strictObject({ optionId: z.string().min(1).max(128) }),
  resolve: ({ answer, secret }) => {
    const entityId = secret.byOption[answer.optionId];
    // An option this picker never offered is refused before the claim is
    // spent, so the card stays answerable.
    return entityId === undefined
      ? unresolvable(`unknown option ${answer.optionId}`)
      : resolved({
          entityId,
          toolName: secret.toolName,
          input: secret.input,
          target: secret.target,
        } satisfies ChoiceResolution);
  },
});

/**
 * `approved` is a literal `true`: this kind has exactly one answer.
 *
 * Saying no is not an answer to a confirmation, it is dropping the question —
 * the same gesture as dismissing a picker, and the same route. Modelling it as
 * `approved: false` would have to resolve to something, and "resolved to doing
 * nothing" is a second meaning for a value the pipeline reads as an
 * authorisation. `unresolvable` is not the escape either: by design it does not
 * spend the claim, so a decline expressed that way would leave the question open
 * forever and block every later job in the conversation.
 */
export const confirmation = defineInteraction<ConfirmationSecret>()({
  ttlMs: CONFIRMATION_TTL_MS,
  prompt: assistantConfirmationPromptSchema,
  answer: z.strictObject({ approved: z.literal(true) }),
  resolve: ({ secret }) =>
    resolved({
      approved: true,
      actionName: secret.actionName,
      canonicalInput: secret.canonicalInput,
      idempotencyKey: secret.idempotencyKey,
      challengeId: secret.challengeId,
    } satisfies ConfirmationResolution),
});

/** The kinds this deployment accepts. The union of keys is the set of kinds. */
export const assistantInteractionTypes = { choice, confirmation };

export type AssistantInteractionTypes = typeof assistantInteractionTypes;

export const assistantInteractions = createInteractions(
  assistantInteractionTypes,
);
