import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner } from "../sho-plan.js";
import type { ShoPlan } from "../sho-turn.js";

import { shoOrderWriteParse } from "./__tests__/order-write-parses.js";
import {
  SHO_WRITE_ACTIONS,
  SHO_WRITE_PLANNERS,
  SHO_READ_AS_CREATE_NOTE,
} from "./orders-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const COMPANY_IDS: Readonly<Record<string, string>> = {
  "c-oksana": "0f6c8ef2-6b4c-4b2a-9f3e-5b1a6c2d7e81",
  "p-tee": "7c1b5d90-2e44-4a1f-8b6d-3f0c9a2e4b57",
  "v-tee-1": "4b2e7a18-9d31-4c6f-83a5-1e0d6f24c7b9",
  "c-oleh": "9a3f1c25-5e78-4d0b-b6e4-2c8a7f13d509",
  "p-cheese": "1d7e4a63-0b92-4f85-9c31-6a5e8d2b4f07",
  "o-7001": "6e0c9b47-3a85-4d19-82f6-5b4a1e7c3d02",
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

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

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

function planOf(command: ShoCommand): ShoPlan {
  const planner = SHO_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no write planner for ${command.action}`);
  }
  return planner.plan(command, NOW);
}

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

  it("plans dv3-lines-27 quantities in milli whatever the spoken unit", () => {
    const plan = planOf(commandOf("dv3-lines-27"));
    expect(plan.kind === "call" ? plan.input["items"] : null).toEqual([
      { productQuery: "кава в зернах lavazza", quantityMilli: "5000" },
      {
        productQuery: "стаканчики",
        variantQuery: "400 мл",
        quantityMilli: "500000",
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

  it("plans the d75-kilo fraction as 500 milli and names no variant", () => {
    const plan = planOf(asCompanyRecords("d75-kilo"));
    expect(plan.kind === "call" ? plan.input["items"] : null).toEqual([
      { productId: COMPANY_IDS["p-cheese"], quantityMilli: "500" },
    ]);
  });

  it("refuses a resolved id that is not a record of this company", () => {
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

  it("refuses a create whose customer the parse never named", () => {
    const said = parseOf("dv3-lines-01")["params"] as Json;
    expect(
      planOf(commandOf("dv3-lines-01", { params: { items: said["items"] } })),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });
});

describe("SHO_WRITE_PLANNERS maps the order lifecycle onto one order id", () => {
  const RESOLVED = {
    text: "його",
    status: "resolved",
    id: COMPANY_IDS["o-7001"],
    name: "№ 7001",
  };

  const confirmOf = (action: string): ShoCommand =>
    commandOf("d88-object-order", {
      action,
      params: { order_number: RESOLVED },
    });

  const LIFECYCLE: Readonly<Record<string, [string, string]>> = {
    "orders.confirm": ["orders_confirm", "Замовлення підтверджено."],
    "orders.start": ["orders_start", "Замовлення в роботі."],
    "orders.complete": ["orders_complete", "Замовлення виконано."],
    "orders.cancel": ["orders_cancel", "Замовлення скасовано."],
  };

  it("plans a resolved order reference as the lifecycle action's orderId", () => {
    for (const [action, [toolName, reply]] of Object.entries(LIFECYCLE)) {
      expect({ action, plan: planOf(confirmOf(action)) }).toEqual({
        action,
        plan: {
          kind: "call",
          toolName,
          reply,
          input: { orderId: COMPANY_IDS["o-7001"] },
        },
      });
    }
  });

  it("refuses d88-object-order while the order is only a focus pronoun", () => {
    expect(planOf(commandOf("d88-object-order"))).toEqual({
      kind: "fallback",
      reason: "conversation_dependent",
    });
  });

  it("refuses the customer, period and amount alternatives of the catalogue", () => {
    expect(
      planOf(
        commandOf("d88-object-order", {
          params: { customer: { text: "оксани", status: "unchecked" } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
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
