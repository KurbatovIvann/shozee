/**
 * What a tool returns. The kit reads this union and nothing else.
 *
 * `needs_choice` and `needs_confirmation` are ordinary outputs, not thrown
 * errors. The kit never inspects an exception, never matches on an action
 * name, and never parses a domain input schema — so adding a new ambiguous
 * write is a change in that tool, not in this package.
 *
 * Ambiguity must be discovered by a read. A tool that attempts its write to
 * find out whether it is ambiguous puts the pause inside a half-done write,
 * which is what forces a two-phase resume.
 */
import { z } from "zod";

import { cardIdSchema } from "./ids.js";

/** Opaque to the kit: `entityId` is a domain id it never dereferences. */
export const choiceOptionSchema = z.strictObject({
  optionId: z.string().min(1).max(128),
  label: z.string().min(1).max(400),
  entityId: z.string().min(1).max(128),
  detail: z.string().min(1).max(400).optional(),
});

export type ChoiceOption = z.output<typeof choiceOptionSchema>;

export const CHOICE_OPTIONS_MAX = 20;

/**
 * A card the tool wants rendered. `payload` is validated by the consumer's
 * own registry (`@showzy/validation`), never here.
 */
export const surfaceRefSchema = z.strictObject({
  cardId: cardIdSchema,
  surface: z.string().min(1).max(64),
  payload: z.unknown(),
});

export type SurfaceRef = z.output<typeof surfaceRefSchema>;

/**
 * `TInput` is the tool's canonical, server-only input. The kit stores it and
 * hands it back on resume; it has no opinion about its shape.
 */
export type ToolOutcome<TInput> =
  | {
      readonly kind: "ok";
      /** Fed back to the model. Clip before returning it. */
      readonly result: unknown;
      readonly surface?: SurfaceRef;
    }
  | {
      readonly kind: "needs_choice";
      /** What the human is choosing between, as a label. Not a domain type. */
      readonly subject: string;
      readonly options: readonly ChoiceOption[];
      readonly optionsTruncated: boolean;
      /** Replayed verbatim after the answer. Never leaves the server. */
      readonly resume: TInput;
    }
  | {
      readonly kind: "needs_confirmation";
      readonly summary: string;
      /** Opaque reference to whatever the domain issued, if anything. */
      readonly challengeRef?: string;
      readonly resume: TInput;
    }
  | {
      readonly kind: "domain_error";
      readonly code: string;
      readonly message: string;
    };

export function isPausing<TInput>(
  outcome: ToolOutcome<TInput>,
): outcome is Extract<
  ToolOutcome<TInput>,
  { kind: "needs_choice" | "needs_confirmation" }
> {
  return outcome.kind === "needs_choice" || outcome.kind === "needs_confirmation";
}
