/**
 * A registry used only by this package's own suites.
 *
 * It exists so the tests have *some* vocabulary to exercise the mechanism
 * with — deliberately abstract (`pick`, `confirm`), and deliberately not
 * exported from the package root. A consumer registers its own kinds; nothing
 * here is a default, a base class, or a suggestion.
 */
import { z } from "zod";

import {
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
} from "./interaction.js";

/** Whatever the caller needs back once an answer arrives. Opaque to the kit. */
export interface PickSecret {
  readonly byOption: Record<string, string>;
  readonly replay: unknown;
}

export const pick = defineInteraction<PickSecret>()({
  ttlMs: 15 * 60 * 1000,
  prompt: z.strictObject({
    question: z.string().min(1),
    options: z
      .array(
        z.strictObject({ id: z.string().min(1), label: z.string().min(1) }),
      )
      .min(1)
      .max(20),
  }),
  answer: z.strictObject({ chose: z.string().min(1) }),
  resolve: ({ answer, secret }) => {
    const value = secret.byOption[answer.chose];
    return value === undefined
      ? unresolvable(`no option ${answer.chose}`)
      : resolved({ chosen: value, replay: secret.replay });
  },
});

export const confirm = defineInteraction<{ readonly replay: unknown }>()({
  // Shorter than `pick`: "are you sure" tolerates interruption less well than
  // "which one". The asymmetry belongs to the kind, not to the deployment.
  ttlMs: 5 * 60 * 1000,
  prompt: z.strictObject({ question: z.string().min(1) }),
  answer: z.strictObject({ agreed: z.boolean() }),
  resolve: ({ answer, secret }) =>
    answer.agreed ? resolved(secret.replay) : unresolvable("declined"),
});

export const fixtureInteractions = createInteractions({ pick, confirm });

export const PICK_SECRET: PickSecret = {
  byOption: { "opt-a": "value-a", "opt-b": "value-b" },
  replay: { n: 1 },
};

export const PICK_PROMPT = {
  question: "which one",
  options: [
    { id: "opt-a", label: "A" },
    { id: "opt-b", label: "B" },
  ],
};
