/**
 * What a tool returns. This package reads this union and nothing else.
 *
 * A pause is an ordinary return value, not a thrown error. Nothing here
 * inspects an exception, matches on a tool name, or parses a caller's input
 * schema, so adding a kind of ambiguity is a change in that tool.
 *
 * Ambiguity must be discovered by a read. A tool that attempts its write to
 * find out whether it is ambiguous puts the pause inside a half-done write,
 * and a two-phase resume is the price.
 */
import { z } from "zod";

/**
 * A card the tool wants rendered. `payload` is validated by the caller's own
 * registry, never here: this package stores the document, it does not know
 * what may appear in it.
 */
export const cardRefSchema = z.strictObject({
  cardId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  payload: z.unknown(),
});

export type CardRef = z.output<typeof cardRefSchema>;

export type ToolOutcome =
  | {
      readonly kind: "ok";
      /** Fed back to the model. Clip it before returning it. */
      readonly result: unknown;
      readonly card?: CardRef;
    }
  | {
      readonly kind: "pause";
      /** A registered interaction kind. Unknown kinds are refused. */
      readonly interaction: string;
      /**
       * The public payload. Validated against the kind's `prompt` schema, and
       * shown to the client and to the model — so it is the caller's job not
       * to put a secret in it.
       */
      readonly prompt: unknown;
      /**
       * Private data the pause keeps for the answer to be resolved against.
       * Never leaves the server. Must survive a JSON round trip.
       */
      readonly secret: unknown;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

export function isPause(
  outcome: ToolOutcome,
): outcome is Extract<ToolOutcome, { kind: "pause" }> {
  return outcome.kind === "pause";
}
