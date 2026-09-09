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
import {
  assistantChoicePromptSchema,
  assistantConfirmationPromptSchema,
} from "@showzy/validation/assistant-chat";
import { z } from "zod";

/** Deliberately longer than a confirmation: "which one" waits better than
 * "are you sure". */
export const CHOICE_TTL_MS = 15 * 60 * 1000;
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

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

export interface ConfirmationSecret {
  readonly canonicalInput: unknown;
  readonly challengeId?: string;
}

export interface ChoiceResolution {
  readonly entityId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly target: ChoicePickerTarget;
}

export interface ConfirmationResolution {
  readonly approved: true;
  readonly canonicalInput: unknown;
  readonly challengeId?: string;
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
      canonicalInput: secret.canonicalInput,
      ...(secret.challengeId !== undefined
        ? { challengeId: secret.challengeId }
        : {}),
    } satisfies ConfirmationResolution),
});

/** The kinds this deployment accepts. The union of keys is the set of kinds. */
export const assistantInteractionTypes = { choice, confirmation };

export type AssistantInteractionTypes = typeof assistantInteractionTypes;

export const assistantInteractions = createInteractions(
  assistantInteractionTypes,
);
