import {
  activatePriceListContract,
  createPriceListContract,
  deactivatePriceListContract,
  deletePriceListContract,
  removePriceListEntriesContract,
  setDefaultPriceListContract,
  setPriceListEntriesContract,
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
  SHO_REMOVE_PRICE_LIST_ENTRIES,
  SHO_SET_DEFAULT_PRICE_LIST,
  SHO_SET_PRICE_LIST_ENTRIES,
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

const OUR_PRODUCT = "3f1c9d2a-4b85-4e70-9a13-6c25d8f04b71";

const OUR_SECOND_PRODUCT = "8e74b0c6-19af-4d53-8b26-0f5a3c91d7e2";

const OUR_VARIANT = "c25b7f10-6a38-4de9-91c4-72f8e5063ab4";

const ANOTHER_COMPANYS_PRODUCT = "d90f3a47-5c21-48be-ae06-19b72c4f8d53";

const SET_PARSE = parseOf("d79-fraction-words");

const REMOVE_PARSE = parseOf("d79-price-list-case");

const resolvedAs = (parse: Json, name: string, id: string): Json => ({
  ...((parse["params"] as Json)[name] as Json),
  id,
});

const saidPrice = (SET_PARSE["params"] as Json)["price"];

const setSaid = (): Json => ({
  price_list: resolvedAs(SET_PARSE, "price_list", OUR_PRICE_LIST),
  product: resolvedAs(SET_PARSE, "product", OUR_PRODUCT),
  variant: resolvedAs(SET_PARSE, "variant", OUR_VARIANT),
  price: saidPrice,
});

const removeSaid = (): Json => ({
  price_list: resolvedAs(REMOVE_PARSE, "price_list", OUR_PRICE_LIST),
  product: resolvedAs(REMOVE_PARSE, "product", OUR_PRODUCT),
  variant: resolvedAs(REMOVE_PARSE, "variant", OUR_VARIANT),
});

const setSaidOnly = (...names: readonly string[]): Json =>
  Object.fromEntries(
    Object.entries(setSaid()).filter(([name]) => names.includes(name)),
  );

const setCommand = (params: Json): ShoCommand =>
  commandOf(SET_PARSE, { params });

const removeCommand = (params: Json): ShoCommand =>
  commandOf(REMOVE_PARSE, { params });

const secondLine = (id: string, patch: Json = {}): Json => ({
  ...resolvedAs(SET_PARSE, "product", id),
  text: "бальзам",
  name: "Бальзам для губ",
  ...patch,
});

const productInFocus = (id: string): ShoFocusEntry => ({
  type: "product",
  id,
  name: "Бальзам для губ",
  how: "shown",
  turns: 0,
});

describe("«в оптовий прайс лак есі за триста сорок» plans the entry write", () => {
  it("plans d79-fraction-words as one entry with the variant and the money", () => {
    expect(planOf(setCommand(setSaid()))).toEqual({
      kind: "call",
      toolName: "pricing_setPriceListEntries",
      reply: "Ціни в прайс-листі оновлено.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [
          {
            productId: OUR_PRODUCT,
            variantId: OUR_VARIANT,
            priceMinor: "34000",
            currency: "UAH",
          },
        ],
      },
    });
  });

  it("plans two product lines at the price the staff member said once", () => {
    expect(
      planOf(
        setCommand({
          ...setSaidOnly("price_list", "product", "price"),
          product: [
            resolvedAs(SET_PARSE, "product", OUR_PRODUCT),
            secondLine(OUR_SECOND_PRODUCT),
          ],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_setPriceListEntries",
      reply: "Ціни в прайс-листі оновлено.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [
          { productId: OUR_PRODUCT, priceMinor: "34000", currency: "UAH" },
          {
            productId: OUR_SECOND_PRODUCT,
            priceMinor: "34000",
            currency: "UAH",
          },
        ],
      },
    });
  });

  it("falls the whole command back when one line names no product the parse knows", () => {
    expect(
      planOf(
        setCommand({
          ...setSaidOnly("price_list", "product", "price"),
          product: [
            resolvedAs(SET_PARSE, "product", OUR_PRODUCT),
            { text: "бальзам", status: "unknown" },
          ],
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("refuses one variant spread over several product lines", () => {
    expect(
      planOf(
        setCommand({
          ...setSaid(),
          product: [
            resolvedAs(SET_PARSE, "product", OUR_PRODUCT),
            secondLine(OUR_SECOND_PRODUCT),
          ],
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses half a price pair rather than guessing the currency", () => {
    expect(
      planOf(
        setCommand({
          ...setSaid(),
          price: { text: "триста сорок", value: { minor: 34000 } },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a price the price list cannot store", () => {
    expect(
      planOf(
        setCommand({
          ...setSaid(),
          price: {
            text: "триста сорок",
            value: { minor: 34000, currency: "USD" },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses the price text the runtime never turned into a value", () => {
    expect(
      planOf(setCommand({ ...setSaid(), price: { text: "триста сорок" } })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a variant the parse did not settle on one id", () => {
    expect(
      planOf(
        setCommand({
          ...setSaid(),
          variant: {
            ...((SET_PARSE["params"] as Json)["variant"] as Json),
            status: "ambiguous",
            id: undefined,
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("asks the model when the parse named no price list to write into", () => {
    expect(
      planOf(setCommand(setSaidOnly("product", "variant", "price"))),
    ).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("stamps the write once, so the turn reaches the preview", () => {
    expect(whitelisted(resultOf(setCommand(setSaid())), NOW)).toEqual({
      kind: "call",
      toolName: "pricing_setPriceListEntries",
      reply: "Ціни в прайс-листі оновлено.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [
          {
            productId: OUR_PRODUCT,
            variantId: OUR_VARIANT,
            priceMinor: "34000",
            currency: "UAH",
          },
        ],
      },
      writes: true,
    });
  });
});

describe("«поло kappa з опту прибери» plans the entry removal", () => {
  it("plans d79-price-list-case as the product and variant keys alone", () => {
    expect(planOf(removeCommand(removeSaid()))).toEqual({
      kind: "call",
      toolName: "pricing_removePriceListEntries",
      reply: "Ціни з прайс-листа прибрано.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [{ productId: OUR_PRODUCT, variantId: OUR_VARIANT }],
      },
    });
  });

  it("refuses a price said over a removal", () => {
    expect(
      planOf(removeCommand({ ...removeSaid(), price: saidPrice })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("carries the misread of a focused price list onto the card", () => {
    expect(
      planOf(
        commandOf(REMOVE_PARSE, {
          params: removeSaid(),
          needs: [
            {
              path: "action",
              reason: "read_as_focus_type",
              blocking: false,
              span: { text: "прибери" },
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_removePriceListEntries",
      reply: "Ціни з прайс-листа прибрано.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [{ productId: OUR_PRODUCT, variantId: OUR_VARIANT }],
      },
      notes: [`${SHO_READ_AS_FOCUS_PRICE_LIST_NOTE}: «прибери».`],
    });
  });
});

describe("a product line binds to the focus the turn actually holds", () => {
  const withContextLine = (id: string): ShoCommand => {
    return setCommand({
      ...setSaidOnly("price_list", "product", "price"),
      product: [
        resolvedAs(SET_PARSE, "product", OUR_PRODUCT),
        secondLine(id, { status: "context" }),
      ],
    });
  };

  it("refuses another company's product id inside the line list", () => {
    expect(
      shoFocusHolds(withContextLine(ANOTHER_COMPANYS_PRODUCT), [
        productInFocus(OUR_SECOND_PRODUCT),
      ]),
    ).toBe(false);
  });

  it("holds a line the turn before put in focus", () => {
    expect(
      shoFocusHolds(withContextLine(OUR_SECOND_PRODUCT), [
        productInFocus(OUR_SECOND_PRODUCT),
      ]),
    ).toBe(true);
  });

  it("plans the focus-held line as its id", () => {
    expect(planOf(withContextLine(OUR_SECOND_PRODUCT))).toEqual({
      kind: "call",
      toolName: "pricing_setPriceListEntries",
      reply: "Ціни в прайс-листі оновлено.",
      input: {
        priceListId: OUR_PRICE_LIST,
        entries: [
          { productId: OUR_PRODUCT, priceMinor: "34000", currency: "UAH" },
          {
            productId: OUR_SECOND_PRODUCT,
            priceMinor: "34000",
            currency: "UAH",
          },
        ],
      },
    });
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

  it("names the nine pricing intents and their mapped params", () => {
    expect(SHO_PRICING_WRITE_ACTIONS).toEqual([
      SHO_CREATE_PRICE_LIST,
      SHO_UPDATE_PRICE_LIST,
      SHO_ACTIVATE_PRICE_LIST,
      SHO_DEACTIVATE_PRICE_LIST,
      SHO_SET_DEFAULT_PRICE_LIST,
      SHO_DELETE_PRICE_LIST,
      SHO_SET_PRICE_LIST_ENTRIES,
      SHO_REMOVE_PRICE_LIST_ENTRIES,
      SHO_CLEAR_DEFAULT_PRICE_LIST,
    ]);
    expect(SHO_PRICING_WRITE_PLANNER_PARAMS).toEqual({
      [SHO_CREATE_PRICE_LIST]: ["new_name", "is_default", "is_active"],
      [SHO_UPDATE_PRICE_LIST]: ["price_list", "rename_to"],
      [SHO_ACTIVATE_PRICE_LIST]: ["price_list"],
      [SHO_DEACTIVATE_PRICE_LIST]: ["price_list"],
      [SHO_SET_DEFAULT_PRICE_LIST]: ["price_list"],
      [SHO_DELETE_PRICE_LIST]: ["price_list"],
      [SHO_SET_PRICE_LIST_ENTRIES]: [
        "price_list",
        "product",
        "variant",
        "price",
      ],
      [SHO_REMOVE_PRICE_LIST_ENTRIES]: ["price_list", "product", "variant"],
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
          setPriceListEntriesContract,
          removePriceListEntriesContract,
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
      [SHO_SET_PRICE_LIST_ENTRIES]: "card",
      [SHO_REMOVE_PRICE_LIST_ENTRIES]: "card",
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
