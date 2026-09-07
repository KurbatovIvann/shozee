import { describe, expect, it } from "vitest";

import {
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  staffAssistantCacheHitRatio,
  staffAssistantCostLogFields,
  staffAssistantTurnUsageFromTotal,
  staffAssistantTurnUsageFromUnknown,
  staffAssistantUncachedInputTokens,
} from "./usage.js";

describe("staffAssistantTurnUsageFromUnknown", () => {
  it("maps flattened LanguageModelUsage including cache details", () => {
    expect(
      staffAssistantTurnUsageFromUnknown({
        inputTokens: 26_000,
        outputTokens: 80,
        inputTokenDetails: {
          cacheReadTokens: 24_000,
          cacheWriteTokens: 1_200,
        },
      }),
    ).toEqual({
      inputTokens: 26_000,
      outputTokens: 80,
      cacheReadTokens: 24_000,
      cacheWriteTokens: 1_200,
    });
  });

  it("maps nested V3/V4 mock usage including cache counters", () => {
    expect(
      staffAssistantTurnUsageFromUnknown({
        inputTokens: {
          total: 100,
          noCache: 10,
          cacheRead: 80,
          cacheWrite: 10,
        },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });

  it("returns zeros when usage is missing or malformed", () => {
    expect(staffAssistantTurnUsageFromUnknown(undefined)).toEqual(
      EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    );
    expect(staffAssistantTurnUsageFromUnknown("nope")).toEqual(
      EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    );
    expect(staffAssistantTurnUsageFromUnknown({})).toEqual(
      EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    );
  });
});

describe("staffAssistantTurnUsageFromTotal", () => {
  it("returns zeros when the usage promise rejects", async () => {
    await expect(
      staffAssistantTurnUsageFromTotal(Promise.reject(new Error("stream"))),
    ).resolves.toEqual(EMPTY_STAFF_ASSISTANT_TURN_USAGE);
  });
});

describe("staffAssistantUncachedInputTokens", () => {
  it("subtracts cache reads and never goes negative", () => {
    expect(
      staffAssistantUncachedInputTokens({
        inputTokens: 26_000,
        outputTokens: 80,
        cacheReadTokens: 24_000,
        cacheWriteTokens: 1_200,
      }),
    ).toBe(2_000);
    expect(
      staffAssistantUncachedInputTokens({
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("staffAssistantCostLogFields", () => {
  it("logs unknown spend as null with cost_known false", () => {
    expect(staffAssistantCostLogFields(null)).toEqual({
      estimated_cost_usd: null,
      cost_known: false,
    });
    expect(staffAssistantCostLogFields(0.012)).toEqual({
      estimated_cost_usd: 0.012,
      cost_known: true,
    });
  });
});

describe("staffAssistantCacheHitRatio", () => {
  it("is cache_read / input, or 0 when input is 0", () => {
    expect(
      staffAssistantCacheHitRatio({
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
      }),
    ).toBe(0.8);
    expect(staffAssistantCacheHitRatio(EMPTY_STAFF_ASSISTANT_TURN_USAGE)).toBe(
      0,
    );
  });
});
