import {
  activatePriceListContract,
  createPriceListContract,
  deactivatePriceListContract,
  deletePriceListContract,
  setDefaultPriceListContract,
  updatePriceListContract,
} from "@showzy/pricing/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoFocusEntry,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { assistantPreviewLevel } from "../assistant-kit-confirmation.js";
import { shoFocusHolds } from "../sho-focus.js";
import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoPricingWriteParse } from "./__tests__/pricing-write-parses.js";
import { SHO_CUSTOMER_WRITE_ACTIONS } from "./customers-writes.js";
import { SHO_DOCUMENT_WRITE_ACTIONS } from "./documents-writes.js";
import { SHO_ORDER_LIFECYCLE_ACTIONS } from "./orders-lifecycle.js";
import { SHO_WRITE_ACTIONS } from "./orders-writes.js";
import {
  SHO_ACTIVATE_PRICE_LIST,
  SHO_CLEAR_DEFAULT_PRICE_LIST,
  SHO_CREATE_PRICE_LIST,
  SHO_DEACTIVATE_PRICE_LIST,
  SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY,
  SHO_DELETE_PRICE_LIST,
  SHO_PRICING_WRITE_ACTIONS,
  SHO_PRICING_WRITE_PLANNERS,
  SHO_PRICING_WRITE_PLANNER_PARAMS,
  SHO_READ_AS_FOCUS_PRICE_LIST_NOTE,
  SHO_SET_DEFAULT_PRICE_LIST,
  SHO_UPDATE_PRICE_LIST,
} from "./pricing-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-10-03T07:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const OUR_PRICE_LIST = "5c0a1f83-62d7-4e19-9b04-37ea8d215c6f";

const ANOTHER_COMPANYS_PRICE_LIST = "a4318e65-07bc-4d52-8f91-2de60b7a9c34";

type Json = Record<string, unknown>;

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoPricingWriteParse(caseId))) as Json;

function resolvedPriceList(id: string): Json {
  const parse = parseOf("d79-price-list-noun");
  const said = parse["params"] as Json;
  return { ...(said["price_list"] as Json), id };
}

const contextPriceList = (id: string): Json => ({
  ...resolvedPriceList(id),
  status: "context",
});

function commandOf(parse: Json, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parse,
    ...patch,
  });
}

function onPriceList(action: string, verb: string, params: Json): ShoCommand {
  return commandOf({
    ...parseOf("d88-unplaced"),
    action,
    verb,
    params,
    needs: [],
    ready: true,
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
    ...SHO_CUSTOMER_WRITE_ACTIONS,
    ...SHO_DOCUMENT_WRITE_ACTIONS,
    ...SHO_PRICING_WRITE_ACTIONS,
  ],
});

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_PRICING_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no pricing planner for ${command.action}`);
  }
  return planner.plan(command, NOW);
}

const priceListInFocus = (id: string): ShoFocusEntry => ({
  type: "price_list",
  id,
  name: "Партнерський",
  how: "shown",
  turns: 0,
});

describe("«створи прайс-лист для блогерів» plans the create", () => {
  it("plans d79-name-lead as pricing_createPriceList on the spoken name", () => {
    expect(planOf(commandOf(parseOf("d79-name-lead")))).toEqual({
      kind: "call",
      toolName: "pricing_createPriceList",
      reply: "Прайс-лист створено.",
      input: { name: "для блогерів" },
    });
  });

  it("prefers the nominative name the parse carries over the span", () => {
    expect(
      planOf(
        commandOf(parseOf("d79-name-lead"), {
          creates: { type: "price_list", name: "Для блогерів" },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_createPriceList",
      reply: "Прайс-лист створено.",
      input: { name: "Для блогерів" },
    });
  });

  it("maps the catalogue's boolean flags onto isDefault and isActive", () => {
    const parse = parseOf("d79-name-lead");
    const said = parse["params"] as Json;
    expect(
      planOf(
        commandOf(parse, {
          params: {
            ...said,
            is_default: { value: "true" },
            is_active: { value: "false" },
          },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_createPriceList",
      reply: "Прайс-лист створено.",
      input: { name: "для блогерів", isDefault: true, isActive: false },
    });
  });

  it("refuses a flag that is not one of the catalogue's two values", () => {
    const parse = parseOf("d79-name-lead");
    const said = parse["params"] as Json;
    expect(
      planOf(
        commandOf(parse, {
          params: { ...said, is_default: { value: "напевно" } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("stamps the write once, so the turn reaches the preview", () => {
    expect(
      whitelisted(resultOf(commandOf(parseOf("d79-name-lead"))), NOW),
    ).toEqual({
      kind: "call",
      toolName: "pricing_createPriceList",
      reply: "Прайс-лист створено.",
      input: { name: "для блогерів" },
      writes: true,
    });
  });
});

describe("a rename reaches the action, an empty update never does", () => {
  it("plans the resolved list and the new name", () => {
    expect(
      planOf(
        onPriceList(SHO_UPDATE_PRICE_LIST, "update", {
          price_list: resolvedPriceList(OUR_PRICE_LIST),
          rename_to: { text: "Партнерський 2027" },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_updatePriceList",
      reply: "Прайс-лист оновлено.",
      input: { id: OUR_PRICE_LIST, name: "Партнерський 2027" },
    });
  });

  it("refuses an update that would change nothing", () => {
    expect(
      planOf(
        onPriceList(SHO_UPDATE_PRICE_LIST, "update", {
          price_list: resolvedPriceList(OUR_PRICE_LIST),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("refuses a price list the parse named but never resolved", () => {
    expect(planOf(commandOf(parseOf("d88-unplaced")))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });

  it("sends that same parse to the model, since it asks for a reference", () => {
    expect(
      whitelisted(resultOf(commandOf(parseOf("d88-unplaced"))), NOW),
    ).toEqual({ kind: "fallback", reason: "needs_reference" });
  });
});

describe("activate, deactivate, set default and delete take the id alone", () => {
  const byId: Readonly<Record<string, readonly [string, string, string]>> = {
    [SHO_ACTIVATE_PRICE_LIST]: [
      "status",
      "pricing_activatePriceList",
      "Прайс-лист активовано.",
    ],
    [SHO_DEACTIVATE_PRICE_LIST]: [
      "status",
      "pricing_deactivatePriceList",
      "Прайс-лист деактивовано.",
    ],
    [SHO_DELETE_PRICE_LIST]: [
      "remove",
      "pricing_deletePriceList",
      "Прайс-лист видалено.",
    ],
  };

  it("maps each intent onto the action's own id field", () => {
    for (const [action, [verb, toolName, reply]] of Object.entries(byId)) {
      expect(
        planOf(
          onPriceList(action, verb, {
            price_list: resolvedPriceList(OUR_PRICE_LIST),
          }),
        ),
      ).toEqual({
        kind: "call",
        toolName,
        reply,
        input: { id: OUR_PRICE_LIST },
      });
    }
  });

  it("names the default's field priceListId, as that action takes it", () => {
    expect(
      planOf(
        onPriceList(SHO_SET_DEFAULT_PRICE_LIST, "status", {
          price_list: resolvedPriceList(OUR_PRICE_LIST),
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: "Прайс-лист призначено основним.",
      input: { priceListId: OUR_PRICE_LIST },
    });
  });

  it("stamps every one a write, so each pauses on the preview", () => {
    for (const action of [...Object.keys(byId), SHO_SET_DEFAULT_PRICE_LIST]) {
      expect(
        whitelisted(
          resultOf(
            onPriceList(action, "status", {
              price_list: resolvedPriceList(OUR_PRICE_LIST),
            }),
          ),
          NOW,
        ),
      ).toMatchObject({ kind: "call", writes: true });
    }
  });

  it("refuses a spoken price list name: these actions take only an id", () => {
    expect(
      planOf(
        onPriceList(SHO_DELETE_PRICE_LIST, "remove", {
          price_list: { text: "гуртовий" },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("notes a non-blocking read_as_focus_type on the card", () => {
    expect(
      planOf(
        commandOf({
          ...parseOf("d88-unplaced"),
          action: SHO_DEACTIVATE_PRICE_LIST,
          verb: "status",
          params: { price_list: contextPriceList(OUR_PRICE_LIST) },
          needs: [
            {
              path: "price_list",
              reason: "read_as_focus_type",
              blocking: false,
              span: { text: "його" },
            },
          ],
          ready: true,
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_deactivatePriceList",
      reply: "Прайс-лист деактивовано.",
      input: { id: OUR_PRICE_LIST },
      notes: [`${SHO_READ_AS_FOCUS_PRICE_LIST_NOTE}: «його».`],
    });
  });

  it("refuses an id that is not shaped like one of ours", () => {
    expect(
      planOf(
        onPriceList(SHO_ACTIVATE_PRICE_LIST, "status", {
          price_list: resolvedPriceList("pl-partner"),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("clearing the default is setDefaultPriceList with a null id", () => {
  const cleared = (params: Json = {}): ShoCommand =>
    onPriceList(SHO_CLEAR_DEFAULT_PRICE_LIST, "status", params);

  it("plans the one action that expresses it", () => {
    expect(planOf(cleared())).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY,
      input: { priceListId: null },
    });
  });

  it("pauses on the preview like every other pricing write", () => {
    expect(whitelisted(resultOf(cleared()), NOW)).toEqual({
      kind: "call",
      toolName: "pricing_setDefaultPriceList",
      reply: SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY,
      input: { priceListId: null },
      writes: true,
    });
  });

  it("refuses a parse that carries a param, since the intent has none", () => {
    expect(
      planOf(cleared({ price_list: resolvedPriceList(OUR_PRICE_LIST) })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("a price list from the conversation binds only when focus holds it", () => {
  const onContext = (id: string): ShoCommand =>
    onPriceList(SHO_DELETE_PRICE_LIST, "remove", {
      price_list: contextPriceList(id),
    });

  it("refuses another company's price list id against this turn's focus", () => {
    expect(
      shoFocusHolds(onContext(ANOTHER_COMPANYS_PRICE_LIST), [
        priceListInFocus(OUR_PRICE_LIST),
      ]),
    ).toBe(false);
  });

  it("holds the price list the turn before put in focus", () => {
    expect(
      shoFocusHolds(onContext(OUR_PRICE_LIST), [
        priceListInFocus(OUR_PRICE_LIST),
      ]),
    ).toBe(true);
  });

  it("refuses a context reference the parse left without an id", () => {
    expect(
      planOf(
        onPriceList(SHO_DELETE_PRICE_LIST, "remove", {
          price_list: { text: "його", status: "context" },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "conversation_dependent" });
  });
});

describe("the pricing write planners stay inside the Шо write protocol", () => {
  it("declares writes on every pricing planner", () => {
    for (const action of SHO_PRICING_WRITE_ACTIONS) {
      expect({
        action,
        writes: SHO_PRICING_WRITE_PLANNERS[action]?.writes,
      }).toEqual({ action, writes: true });
    }
  });

  it("names the seven pricing intents and their mapped params", () => {
    expect(SHO_PRICING_WRITE_ACTIONS).toEqual([
      SHO_CREATE_PRICE_LIST,
      SHO_UPDATE_PRICE_LIST,
      SHO_ACTIVATE_PRICE_LIST,
      SHO_DEACTIVATE_PRICE_LIST,
      SHO_SET_DEFAULT_PRICE_LIST,
      SHO_DELETE_PRICE_LIST,
      SHO_CLEAR_DEFAULT_PRICE_LIST,
    ]);
    expect(SHO_PRICING_WRITE_PLANNER_PARAMS).toEqual({
      [SHO_CREATE_PRICE_LIST]: ["new_name", "is_default", "is_active"],
      [SHO_UPDATE_PRICE_LIST]: ["price_list", "rename_to"],
      [SHO_ACTIVATE_PRICE_LIST]: ["price_list"],
      [SHO_DEACTIVATE_PRICE_LIST]: ["price_list"],
      [SHO_SET_DEFAULT_PRICE_LIST]: ["price_list"],
      [SHO_DELETE_PRICE_LIST]: ["price_list"],
      [SHO_CLEAR_DEFAULT_PRICE_LIST]: [],
    });
  });

  it("pauses every planned action, and the delete on a strong card", () => {
    expect(
      Object.fromEntries(
        [
          createPriceListContract,
          updatePriceListContract,
          activatePriceListContract,
          deactivatePriceListContract,
          setDefaultPriceListContract,
          deletePriceListContract,
        ].map((contract) => [
          contract.name,
          assistantPreviewLevel(contract.risk),
        ]),
      ),
    ).toEqual({
      [SHO_CREATE_PRICE_LIST]: "card",
      [SHO_UPDATE_PRICE_LIST]: "card",
      [SHO_ACTIVATE_PRICE_LIST]: "card",
      [SHO_DEACTIVATE_PRICE_LIST]: "card",
      [SHO_SET_DEFAULT_PRICE_LIST]: "card",
      [SHO_DELETE_PRICE_LIST]: "strong",
    });
  });

  it("refuses a pricing parse that arrives with a read's effect", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf(parseOf("d79-name-lead"), {
            kind: "read",
            effect: "read",
            confirm: "none",
          }),
        ),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans nothing for a pricing write no deployment whitelisted", () => {
    expect(
      createShoPlanner({ actions: [...SHO_READ_ACTIONS] })(
        resultOf(commandOf(parseOf("d79-name-lead"))),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});
