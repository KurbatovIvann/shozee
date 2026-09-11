import { CoreInvariantError } from "@showzy/core/errors";
import { ASSISTANT_TURN_RESERVATION_MAX_USD } from "@showzy/validation/assistant-budget";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  assertStaffAssistantBudgetLimits,
} from "./assistant-budget-guard.js";

describe("the per-turn reservation", () => {
  /**
   * A turn row refuses a hold above the bound. A reservation above it would be
   * taken from the counters and never recorded where a release can find it.
   */
  it("may not exceed what a turn row holds", () => {
    const limits = (unknownModelTurnUsd: number) => ({
      ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
      unknownModelTurnUsd,
    });

    expect(assertStaffAssistantBudgetLimits(DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS)).toBe(
      DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    );
    expect(() =>
      assertStaffAssistantBudgetLimits(limits(ASSISTANT_TURN_RESERVATION_MAX_USD)),
    ).not.toThrow();
    expect(() =>
      assertStaffAssistantBudgetLimits(
        limits(ASSISTANT_TURN_RESERVATION_MAX_USD + 0.01),
      ),
    ).toThrow(CoreInvariantError);
    expect(() => assertStaffAssistantBudgetLimits(limits(Number.NaN))).toThrow(
      CoreInvariantError,
    );
  });
});
