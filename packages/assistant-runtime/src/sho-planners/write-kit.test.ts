import { shoCommandSchema, type ShoCommand } from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import {
  shoWritePlanner,
  type ShoWriteParamMapper,
  type ShoWritePlan,
} from "./write-kit.js";

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const said =
  (field: string): ShoWriteParamMapper =>
  (param) =>
    Array.isArray(param) || !("text" in param)
      ? "unsupported_param"
      : { [field]: param.text };

const commandOf = (params: Record<string, unknown>): ShoCommand =>
  shoCommandSchema.parse({
    text: "зроби щось",
    action: "pricing.clearDefaultPriceList",
    kind: "write",
    effect: "write",
    confirm: "card",
    params,
    needs: [],
    ready: true,
    refPrevious: {},
    catalogued: false,
    confidence: OVER_THE_FLOOR,
  });

const planOf = (plan: ShoWritePlan, params: Record<string, unknown> = {}) =>
  shoWritePlanner(plan).plan(commandOf(params), new Date());

const WITH_CONSTANT: ShoWritePlan = {
  toolName: "pricing_setDefaultPriceList",
  reply: "Готово.",
  params: {},
  constants: { priceListId: null },
  required: [],
};

describe("a write plan's constants reach the input the planner hands back", () => {
  it("sends a field the parse never carried, since the action requires it", () => {
    expect(planOf(WITH_CONSTANT)).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: "Готово.",
      input: { priceListId: null },
    });
  });

  it("merges constants beside the params the parse did carry", () => {
    expect(
      planOf(
        { ...WITH_CONSTANT, params: { note: said("reason") } },
        { note: { text: "вручну" } },
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: "Готово.",
      input: { reason: "вручну", priceListId: null },
    });
  });

  it("refuses a constant a mapped param already wrote", () => {
    expect(
      planOf(
        { ...WITH_CONSTANT, params: { note: said("priceListId") } },
        { note: { text: "pl-1" } },
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("writes nothing extra when a plan declares no constants", () => {
    expect(
      planOf(
        {
          toolName: "pricing_setDefaultPriceList",
          reply: "Готово.",
          params: { note: said("reason") },
          required: ["note"],
        },
        { note: { text: "вручну" } },
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: "Готово.",
      input: { reason: "вручну" },
    });
  });

  it("plans no call at all when a required param was never said", () => {
    expect(planOf({ ...WITH_CONSTANT, required: ["note"] })).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });
});
