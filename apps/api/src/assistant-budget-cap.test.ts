/**
 * One cap on a turn's budget reservation, spelled in two packages that may not
 * import each other (SHO-560).
 *
 * `@showzy/config` refuses a configured reservation above its value, and the
 * assistant contract refuses a stored hold above `@showzy/validation`'s. The
 * configuration package takes no workspace dependencies, so the value is
 * repeated; this is the one place that sees both, and it pins them equal so a
 * process can never reserve more than a turn row is allowed to hold.
 */
import { AI_UNKNOWN_MODEL_TURN_USD_MAX } from "@showzy/config";
import { ASSISTANT_TURN_RESERVATION_MAX_USD } from "@showzy/validation/assistant-budget";
import { describe, expect, it } from "vitest";

describe("the per-turn reservation cap", () => {
  it("is the same in configuration and in the turn contract", () => {
    expect(AI_UNKNOWN_MODEL_TURN_USD_MAX).toBe(
      ASSISTANT_TURN_RESERVATION_MAX_USD,
    );
  });
});
