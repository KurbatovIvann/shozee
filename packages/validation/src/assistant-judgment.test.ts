import { describe, expect, it } from "vitest";

import {
  JUDGMENT_SHADOW_ARGS_MAX,
  JUDGMENT_SHADOW_TEXT_MAX,
  judgmentShadowSchema,
} from "./assistant-judgment.js";

const declined = {
  version: 2,
  rewriteUsed: false,
  model: "jev-1.13.0",
  latencyMs: 0,
  refusal: "timeout",
  wouldTake: false,
  declinedBecause: "refused",
  modelFirstCall: null,
  toolAgrees: null,
  argsAgree: null,
};

describe("judgmentShadowSchema", () => {
  it("accepts a refusal with nothing planned and nothing to compare", () => {
    expect(judgmentShadowSchema.parse(declined)).toEqual(declined);
  });

  it("accepts a plan with closed, text, number and list arguments", () => {
    const parsed = judgmentShadowSchema.parse({
      ...declined,
      refusal: undefined,
      declinedBecause: "write",
      kind: "request",
      kindConfidence: 0.97,
      plan: {
        tool: "orders_create",
        args: { customerQuery: "олени петренко", items: ["2×капучино"] },
        risk: "write",
        minConfidence: 0.82,
      },
      modelFirstCall: {
        tool: "orders_create",
        args: { customerQuery: "Олена Петренко", limit: 5, draft: false },
      },
      toolAgrees: true,
      argsAgree: true,
    });
    expect(parsed.plan?.risk).toBe("write");
  });

  it("refuses unbounded text, too many arguments and unknown fields", () => {
    const call = (args: Record<string, unknown>) => ({
      ...declined,
      modelFirstCall: { tool: "search_query", args },
    });
    expect(
      judgmentShadowSchema.safeParse(
        call({ query: "x".repeat(JUDGMENT_SHADOW_TEXT_MAX + 1) }),
      ).success,
    ).toBe(false);
    expect(
      judgmentShadowSchema.safeParse(
        call(
          Object.fromEntries(
            Array.from({ length: JUDGMENT_SHADOW_ARGS_MAX + 1 }, (_, i) => [
              `a${String(i)}`,
              1,
            ]),
          ),
        ),
      ).success,
    ).toBe(false);
    expect(
      judgmentShadowSchema.safeParse({ ...declined, prompt: "free text" })
        .success,
    ).toBe(false);
  });
});
