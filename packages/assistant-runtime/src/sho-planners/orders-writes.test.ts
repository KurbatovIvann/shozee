import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoOrderWriteParse } from "./__tests__/order-write-parses.js";
import {
  SHO_WRITE_ACTIONS,
  SHO_WRITE_PLANNERS,
  SHO_READ_AS_CREATE_NOTE,
} from "./orders-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const COMPANY_IDS: Readonly<Record<string, string>> = {
  "c-oksana": "0f6c8ef2-6b4c-4b2a-9f3e-5b1a6c2d7e81",
  "p-tee": "7c1b5d90-2e44-4a1f-8b6d-3f0c9a2e4b57",
  "v-tee-1": "4b2e7a18-9d31-4c6f-83a5-1e0d6f24c7b9",
  "c-olena": "9a3f1c25-5e78-4d0b-b6e4-2c8a7f13d509",
  "p-rolls": "1d7e4a63-0b92-4f85-9c31-6a5e8d2b4f07",
  "c-oleh": "3f8b2d64-7c15-4e90-a2d3-8b6f1c04e725",
  "p-cheese": "5c4a9e03-1b76-4d82-9f15-7e3b2a60c814",
};

type Json = Record<string, unknown>;

function reId(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => reId(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "id" && typeof entry === "string"
        ? (COMPANY_IDS[entry] ?? entry)
        : reId(entry),
    ]),
  );
}

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoOrderWriteParse(caseId))) as Json;

function commandOf(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parseOf(caseId),
    ...patch,
  });
}

function asCompanyRecords(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...(reId(parseOf(caseId)) as Json),
    ...patch,
  });
}

function resultOf(command: ShoCommand): ShoResult {
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: command.text,
    segments: [command.text],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 1, revision: null },
  });
}

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no write planner for ${command.action}`);
  }
  return planner.plan(command, NOW);
}

const itemsOf = (plan: ShoActionPlan): unknown =>
  plan.kind === "call" ? plan.input["items"] : null;

const whitelisted = createShoPlanner({
  actions: [...SHO_READ_ACTIONS, ...SHO_WRITE_ACTIONS],
});

describe("SHO_WRITE_PLANNERS maps the conformance order-create parses", () => {
  it("plans dv3-lines-01 as queries, implicit quantities and attr variants", () => {
    expect(planOf(commandOf("dv3-lines-01"))).toEqual({
      kind: "call",
      toolName: "orders_create",
      reply: "Замовлення створено.",
      input: {
        customerQuery: "оксани",
        items: [
          {
            productQuery: "сукня коктейльна",
            variantQuery: "червона 42",
            quantityMilli: "1000",
          },
          {
            productQuery: "тренч",
            variantQuery: "бежевий m",
            quantityMilli: "1000",
          },
        ],
      },
    });
  });

  it("plans the dv3-lines-16 counts in milli", () => {
    expect(itemsOf(planOf(commandOf("dv3-lines-16")))).toEqual([
      {
        productQuery: "бальзам для губ",
        variantQuery: "полуничний",
        quantityMilli: "10000",
      },
      {
        productQuery: "сироватка з вітаміном c",
        variantQuery: "30 мл",
        quantityMilli: "5000",
      },
    ]);
  });

  it("plans d78-attrs-colour-size on the company's own ids", () => {
    expect(planOf(asCompanyRecords("d78-attrs-colour-size"))).toEqual({
      kind: "call",
      toolName: "orders_create",
      reply: "Замовлення створено.",
      input: {
        customerId: COMPANY_IDS["c-oksana"],
        items: [
          {
            productId: COMPANY_IDS["p-tee"],
            variantId: COMPANY_IDS["v-tee-1"],
            quantityMilli: "1000",
          },
        ],
      },
    });
  });

  it("names no variant for the d73-surname-unknown product that has none", () => {
    expect(itemsOf(planOf(asCompanyRecords("d73-surname-unknown")))).toEqual([
      { productId: COMPANY_IDS["p-rolls"], quantityMilli: "3000" },
    ]);
  });

  it("plans the dv3-lines-20 count said in cans", () => {
    expect(itemsOf(planOf(commandOf("dv3-lines-20")))).toEqual([
      {
        productQuery: "фарба caparol",
        variantQuery: "біла 10 літрів",
        quantityMilli: "2000",
      },
    ]);
  });

  it("refuses the d75-kilo weight until the context carries the sale unit", () => {
    expect(planOf(asCompanyRecords("d75-kilo"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses the dv3-lines-19 area and sacks for the same reason", () => {
    expect(planOf(commandOf("dv3-lines-19"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("counts only the units that count pieces whatever the product is sold in", () => {
    const withUnit = (unit: string | null): ShoActionPlan => {
      const said = parseOf("dv3-lines-20")["params"] as Json;
      const items = JSON.parse(JSON.stringify(said["items"])) as {
        quantity: { unit: string | null };
      }[];
      const line = items[0];
      if (line === undefined) {
        throw new Error("dv3-lines-20 lost its line");
      }
      line.quantity.unit = unit;
      return planOf(
        commandOf("dv3-lines-20", {
          params: { customer: said["customer"], items },
        }),
      );
    };

    for (const unit of [null, "pcs", "pair", "bottle", "can"]) {
      expect({ unit, kind: withUnit(unit).kind }).toEqual({
        unit,
        kind: "call",
      });
    }
    for (const unit of [
      "box",
      "set",
      "bag",
      "roll",
      "sheet",
      "bucket",
      "pack",
      "m",
      "m2",
      "m3",
      "g",
      "kg",
      "t",
      "l",
      "ml",
    ]) {
      expect({ unit, plan: withUnit(unit) }).toEqual({
        unit,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("refuses a resolved id that is not shaped like a uuid", () => {
    expect(planOf(commandOf("d94-order-phone-dative"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses dv3-orders-25 because the façade takes no due or payment", () => {
    expect(planOf(commandOf("dv3-orders-25"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("stores the comment as it was said, never a normalised value", () => {
    const said = parseOf("dv3-lines-01")["params"] as Json;
    const plan = planOf(
      commandOf("dv3-lines-01", {
        params: {
          ...said,
          comment: { text: "передзвонити зранку", value: "0503341290" },
        },
      }),
    );
    expect(plan.kind === "call" ? plan.input["comment"] : null).toBe(
      "передзвонити зранку",
    );
  });

  it("refuses a create whose customer the parse never named", () => {
    const said = parseOf("dv3-lines-01")["params"] as Json;
    expect(
      planOf(commandOf("dv3-lines-01", { params: { items: said["items"] } })),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });
});

describe("a Шо write only ever reaches the preview", () => {
  it("declares writes on every order write planner", () => {
    for (const action of SHO_WRITE_ACTIONS) {
      expect({ action, writes: SHO_WRITE_PLANNERS[action]?.writes }).toEqual({
        action,
        writes: true,
      });
    }
  });

  it("sends d95-noun-alone-confirm to the LLM, never to a write", () => {
    expect(
      whitelisted(resultOf(commandOf("d95-noun-alone-confirm")), NOW),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("sends d90-closed-order to the LLM, never to a write", () => {
    expect(whitelisted(resultOf(commandOf("d90-closed-order")), NOW)).toEqual({
      kind: "fallback",
      reason: "needs_reference",
    });
  });

  it("refuses a write parse that arrives with a read's effect", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf("dv3-lines-01", {
            kind: "read",
            effect: "read",
            confirm: "none",
          }),
        ),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans nothing for an order write that no deployment whitelisted", () => {
    expect(
      createShoPlanner({ actions: [...SHO_READ_ACTIONS] })(
        resultOf(commandOf("dv3-lines-01")),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});

describe("a read_as_create misread is carried to the card", () => {
  const withNeed = (span: string | null): ShoCommand =>
    commandOf("dv3-lines-01", {
      needs: [
        {
          path: "action",
          reason: "read_as_create",
          blocking: false,
          ...(span === null ? {} : { span: { text: span } }),
        },
      ],
    });

  it("notes the span the misread hangs on", () => {
    const plan = planOf(withNeed("додай"));
    expect(plan.kind === "call" ? plan.notes : null).toEqual([
      `${SHO_READ_AS_CREATE_NOTE}: «додай».`,
    ]);
  });

  it("notes the misread even with no span to quote", () => {
    const plan = planOf(withNeed(null));
    expect(plan.kind === "call" ? plan.notes : null).toEqual([
      `${SHO_READ_AS_CREATE_NOTE}.`,
    ]);
  });

  it("carries no note when the parse reports no misread", () => {
    const plan = planOf(commandOf("dv3-lines-01"));
    expect(plan.kind === "call" ? plan.notes : "not a call").toBeUndefined();
  });
});
