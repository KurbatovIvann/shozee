import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoFocusEntry,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { shoFocusHolds } from "../sho-focus.js";
import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoOrderWriteParse } from "./__tests__/order-write-parses.js";
import {
  SHO_CANCEL_ORDER,
  SHO_COMPLETE_ORDER,
  SHO_CONFIRM_ORDER,
  SHO_ORDER_LIFECYCLE_ACTIONS,
  SHO_ORDER_LIFECYCLE_PLANNERS,
  SHO_ORDER_LIFECYCLE_PLANNER_PARAMS,
  SHO_READ_AS_FOCUS_ORDER_NOTE,
  SHO_START_ORDER,
} from "./orders-lifecycle.js";
import { SHO_WRITE_ACTIONS } from "./orders-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-27T07:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const OUR_ORDER = "2b7c6e14-9a05-4f31-8d62-70c4e5a1b398";

const ANOTHER_COMPANYS_ORDER = "c51f0a82-4d37-4b96-a7e0-18d3925c6f4a";

const OUR_CUSTOMER = "9a3f1c25-5e78-4d0b-b6e4-2c8a7f13d509";

type Json = Record<string, unknown>;

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoOrderWriteParse(caseId))) as Json;

function focusedOn(id: string): Json {
  const parse = parseOf("d88-object-order");
  const said = parse["params"] as Json;
  const ref = said["order_number"] as Json;
  return { ...parse, params: { order_number: { ...ref, id } } };
}

function commandOf(parse: Json, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parse,
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

const whitelisted = createShoPlanner({
  actions: [
    ...SHO_READ_ACTIONS,
    ...SHO_WRITE_ACTIONS,
    ...SHO_ORDER_LIFECYCLE_ACTIONS,
  ],
});

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_ORDER_LIFECYCLE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no lifecycle planner for ${command.action}`);
  }
  return planner.plan(command, NOW);
}

const inFocus = (id: string): ShoFocusEntry => ({
  type: "order",
  id,
  name: "№ 7001",
  how: "created",
  turns: 0,
});

describe("«підтверди його» binds to the order the focus holds", () => {
  it("plans d88-object-order as orders_confirm on the focus order", () => {
    expect(planOf(commandOf(focusedOn(OUR_ORDER)))).toEqual({
      kind: "call",
      toolName: "orders_confirm",
      reply: "Замовлення підтверджено.",
      input: { orderId: OUR_ORDER },
    });
  });

  it("stamps the write once, so the turn reaches the preview", () => {
    expect(whitelisted(resultOf(commandOf(focusedOn(OUR_ORDER))), NOW)).toEqual(
      {
        kind: "call",
        toolName: "orders_confirm",
        reply: "Замовлення підтверджено.",
        input: { orderId: OUR_ORDER },
        writes: true,
      },
    );
  });

  it("plans the same reference for start, complete and cancel", () => {
    const verbs: Readonly<Record<string, readonly [string, string]>> = {
      [SHO_START_ORDER]: ["orders_start", "Замовлення в роботі."],
      [SHO_COMPLETE_ORDER]: ["orders_complete", "Замовлення виконано."],
      [SHO_CANCEL_ORDER]: ["orders_cancel", "Замовлення скасовано."],
    };
    for (const [action, [toolName, reply]] of Object.entries(verbs)) {
      expect(
        planOf(commandOf(focusedOn(OUR_ORDER), { action, verb: "status" })),
      ).toEqual({
        kind: "call",
        toolName,
        input: { orderId: OUR_ORDER },
        reply,
      });
    }
  });

  it("sends a cancel through the preview like every other Шо write", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf(focusedOn(OUR_ORDER), {
            text: "скасуй його",
            action: SHO_CANCEL_ORDER,
            verb: "cancel",
          }),
        ),
        NOW,
      ),
    ).toMatchObject({
      kind: "call",
      toolName: "orders_cancel",
      input: { orderId: OUR_ORDER },
      writes: true,
    });
  });
});

describe("a focus-type misread is carried to the card", () => {
  const misread = (): ShoCommand =>
    commandOf(focusedOn(OUR_ORDER), {
      text: "видали її вже нарешті",
      action: SHO_CANCEL_ORDER,
      verb: "cancel",
      needs: parseOf("d89-delete-customer")["needs"],
    });

  it("notes the span the delete-family misread hangs on", () => {
    const plan = planOf(misread());
    expect(plan.kind === "call" ? plan.notes : null).toEqual([
      `${SHO_READ_AS_FOCUS_ORDER_NOTE}: «її».`,
    ]);
  });

  it("keeps the note on the write the preview pauses", () => {
    expect(whitelisted(resultOf(misread()), NOW)).toMatchObject({
      kind: "call",
      toolName: "orders_cancel",
      input: { orderId: OUR_ORDER },
      writes: true,
      notes: [`${SHO_READ_AS_FOCUS_ORDER_NOTE}: «її».`],
    });
  });

  it("carries no note when the parse reports no misread", () => {
    const plan = planOf(commandOf(focusedOn(OUR_ORDER)));
    expect(plan.kind === "call" ? plan.notes : "not a call").toBeUndefined();
  });
});

describe("an order the focus does not hold is never written to", () => {
  it("refuses another company's order id against this turn's focus", () => {
    expect(
      shoFocusHolds(commandOf(focusedOn(ANOTHER_COMPANYS_ORDER)), [
        inFocus(OUR_ORDER),
      ]),
    ).toBe(false);
  });

  it("holds the order the same turn put in focus", () => {
    expect(
      shoFocusHolds(commandOf(focusedOn(OUR_ORDER)), [inFocus(OUR_ORDER)]),
    ).toBe(true);
  });

  it("refuses a resolved order ref, uuid or not: only focus binds a write", () => {
    const parse = parseOf("d88-object-order");
    expect(
      planOf(
        commandOf(parse, {
          params: {
            order_number: {
              text: "його",
              status: "resolved",
              id: OUR_ORDER,
              name: "№ 7001",
            },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a context reference the parse left without an id", () => {
    const parse = parseOf("d88-object-order");
    expect(
      planOf(
        commandOf(parse, {
          params: { order_number: { text: "його", status: "context" } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "conversation_dependent" });
  });
});

describe("a spoken order number is not a reference a write can follow", () => {
  it("refuses the dv3 digit span «131»", () => {
    expect(
      planOf(
        commandOf(focusedOn(OUR_ORDER), {
          text: "підтверди 131",
          params: { order_number: { text: "131", value: 131 } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses an order described by its customer", () => {
    expect(
      planOf(
        commandOf(focusedOn(OUR_ORDER), {
          text: "підтверди замовлення олени петренко",
          params: {
            customer: {
              text: "олені петренко",
              status: "resolved",
              id: OUR_CUSTOMER,
              name: "Олена",
              match: "form",
            },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a lifecycle write the parse left without an order", () => {
    expect(
      whitelisted(resultOf(commandOf(parseOf("d95-noun-alone-confirm"))), NOW),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("sends a closed-order reference need to the LLM", () => {
    expect(
      whitelisted(resultOf(commandOf(parseOf("d90-closed-order"))), NOW),
    ).toEqual({ kind: "fallback", reason: "needs_reference" });
  });
});

describe("the lifecycle planners stay inside the Шо write protocol", () => {
  it("declares writes on every lifecycle planner", () => {
    for (const action of SHO_ORDER_LIFECYCLE_ACTIONS) {
      expect({
        action,
        writes: SHO_ORDER_LIFECYCLE_PLANNERS[action]?.writes,
      }).toEqual({ action, writes: true });
    }
  });

  it("names the four lifecycle actions and their mapped params", () => {
    expect(SHO_ORDER_LIFECYCLE_ACTIONS).toEqual([
      SHO_CONFIRM_ORDER,
      SHO_START_ORDER,
      SHO_COMPLETE_ORDER,
      SHO_CANCEL_ORDER,
    ]);
    expect(SHO_ORDER_LIFECYCLE_PLANNER_PARAMS).toEqual({
      [SHO_CONFIRM_ORDER]: ["order_number"],
      [SHO_START_ORDER]: ["order_number"],
      [SHO_COMPLETE_ORDER]: ["order_number"],
      [SHO_CANCEL_ORDER]: ["order_number"],
    });
  });

  it("refuses a lifecycle parse that arrives with a read's effect", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf(focusedOn(OUR_ORDER), {
            kind: "read",
            effect: "read",
            confirm: "none",
          }),
        ),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans nothing for a lifecycle write no deployment whitelisted", () => {
    expect(
      createShoPlanner({
        actions: [...SHO_READ_ACTIONS, ...SHO_WRITE_ACTIONS],
      })(resultOf(commandOf(focusedOn(OUR_ORDER))), NOW),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});
