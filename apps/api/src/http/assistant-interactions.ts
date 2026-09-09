/**
 * The kinds of question this product asks, and what a valid answer to each
 * looks like.
 *
 * This is the half `@showzy/assistant-kit` deliberately does not have. The
 * package owns the mechanism — claim once, refuse a stale revision, replay the
 * continuation — and knows nothing about pickers, confirmations, option caps
 * or entity ids. All of that lives here, where it can change without touching
 * a line of the protocol.
 */
import {
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
} from "@showzy/assistant-kit";
import { z } from "zod";

/**
 * Cap on a picker. Chosen for this product's UI, not by the protocol: a
 * six-flavour product needs more than five, and a list past twenty stops being
 * a choice.
 */
export const CHOICE_OPTIONS_MAX = 20;

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

export const choicePromptSchema = z.strictObject({
  subject: z.string().min(1).max(200),
  options: z
    .array(
      z.strictObject({
        optionId: z.string().min(1).max(128),
        label: z.string().min(1).max(400),
        detail: z.string().min(1).max(400).optional(),
      }),
    )
    .min(1)
    .max(CHOICE_OPTIONS_MAX),
  /** True when the real list was longer than the cap above. */
  optionsTruncated: z.boolean(),
});

export const confirmationPromptSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
});

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
  prompt: choicePromptSchema,
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

export const confirmation = defineInteraction<ConfirmationSecret>()({
  ttlMs: CONFIRMATION_TTL_MS,
  prompt: confirmationPromptSchema,
  answer: z.strictObject({ approved: z.boolean() }),
  resolve: ({ answer, secret }) =>
    answer.approved
      ? resolved({
          approved: true,
          canonicalInput: secret.canonicalInput,
          ...(secret.challengeId !== undefined
            ? { challengeId: secret.challengeId }
            : {}),
        } satisfies ConfirmationResolution)
      : unresolvable("declined"),
});

/** The kinds this deployment accepts. The union of keys is the set of kinds. */
export const assistantInteractionTypes = { choice, confirmation };

export type AssistantInteractionTypes = typeof assistantInteractionTypes;

export const assistantInteractions = createInteractions(
  assistantInteractionTypes,
);
