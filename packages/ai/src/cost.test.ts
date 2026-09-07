import { describe, expect, it } from "vitest";

import {
  estimateStaffAssistantCostUsd,
  estimateStaffAssistantTurnCostUsd,
  staffAssistantAnthropicRateTier,
  STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK,
} from "./cost.js";
import {
  staffAssistantCostLogFields,
  type StaffAssistantTurnUsage,
} from "./usage.js";

const fixture: StaffAssistantTurnUsage = {
  inputTokens: 100_000,
  outputTokens: 200,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 16_000,
};

describe("STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK", () => {
  it("prices cache writes at 2× input for mixed 1h+5m admission", () => {
    expect(STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK).toEqual({
      sonnet: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 6,
      },
      haiku: {
        input: 1,
        output: 5,
        cacheRead: 0.1,
        cacheWrite: 2,
      },
      opus: {
        input: 15,
        output: 75,
        cacheRead: 1.5,
        cacheWrite: 30,
      },
    });
  });
});

describe("estimateStaffAssistantCostUsd", () => {
  it("returns a finite USD estimate for a known token fixture", () => {
    const uncached = 100_000 - 80_000 - 16_000;
    const expected =
      (uncached * 3 + 80_000 * 0.3 + 16_000 * 6 + 200 * 15) / 1_000_000;
    const usd = estimateStaffAssistantCostUsd(fixture, "claude-sonnet-4-6");
    expect(usd).toBeCloseTo(expected, 8);
    expect(staffAssistantAnthropicRateTier("claude-haiku-4-5")).toBe("haiku");
    const haiku = estimateStaffAssistantCostUsd(fixture, "claude-haiku-4-5");
    expect(usd).not.toBeNull();
    expect(haiku).not.toBeNull();
    if (usd === null || haiku === null) {
      return;
    }
    expect(haiku).toBeLessThan(usd);
  });

  it("returns null for a model the adapter does not price", () => {
    expect(staffAssistantAnthropicRateTier("some-unknown-model")).toBeNull();
    expect(
      estimateStaffAssistantCostUsd(fixture, "some-unknown-model"),
    ).toBeNull();
    expect(staffAssistantCostLogFields(null)).toEqual({
      estimated_cost_usd: null,
      cost_known: false,
    });
    const opus = estimateStaffAssistantCostUsd(fixture, "claude-opus-4-6");
    const sonnet = estimateStaffAssistantCostUsd(fixture, "claude-sonnet-4-6");
    expect(opus).not.toBeNull();
    expect(sonnet).not.toBeNull();
    if (opus === null || sonnet === null) {
      return;
    }
    expect(opus).toBeGreaterThan(sonnet);
  });

  it("adds gate and reply spend on a turn", () => {
    const gate: StaffAssistantTurnUsage = {
      inputTokens: 1_000,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const total = estimateStaffAssistantTurnCostUsd({
      reply: fixture,
      replyModelId: "claude-sonnet-4-6",
      gate,
      gateModelId: "claude-haiku-4-5",
    });
    const replyOnly = estimateStaffAssistantCostUsd(
      fixture,
      "claude-sonnet-4-6",
    );
    expect(total).not.toBeNull();
    expect(replyOnly).not.toBeNull();
    if (total === null || replyOnly === null) {
      return;
    }
    expect(total).toBeGreaterThan(replyOnly);
    expect(
      estimateStaffAssistantTurnCostUsd({
        reply: fixture,
        replyModelId: "claude-sonnet-4-6",
        gate,
        gateModelId: "some-unknown-model",
      }),
    ).toBeNull();
  });
});
