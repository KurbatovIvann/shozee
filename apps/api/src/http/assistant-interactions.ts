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
 * Server-side only. `byOption` never reaches a client — the client sends an
 * `optionId` and the server says what it meant.
 */
export interface ChoiceSecret {
  readonly byOption: Record<string, string>;
  /** The canonical input to replay once the ambiguity is settled. */
  readonly canonicalInput: unknown;
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
  readonly canonicalInput: unknown;
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
          canonicalInput: secret.canonicalInput,
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
