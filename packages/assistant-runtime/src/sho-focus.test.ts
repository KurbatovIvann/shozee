import {
  CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  toProviderToolName,
} from "@showzy/ai";
import type { ModelMessage } from "@showzy/assistant-kit";
import {
  shoCommandSchema,
  SHO_MOST_FOCUS,
  type ShoCommand,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import {
  shoFocusFrom,
  shoLogOptions,
  shoPreviousFrom,
  shoTurnRecords,
  type ShoTurnLog,
} from "./sho-focus.js";

const SESSION = "6a1d0f72-2c44-4a0b-9f31-5d8e2b7c4a10";
const OTHER_SESSION = "0b9c7e55-13aa-4f28-8c60-9e4d1a3f7b22";
const AT = "2026-10-02T09:00:00.000Z";
const KATE = "11111111-1111-4111-8111-111111111111";
const OLHA = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const PRICE_LIST = "44444444-4444-4444-8444-444444444444";
const CREATE_CUSTOMER_TOOL = toProviderToolName("customers.createCustomer");
const GET_PRICE_LIST_TOOL = toProviderToolName("pricing.getPriceList");

function commandOf(fields: Readonly<Record<string, unknown>>): ShoCommand {
  return shoCommandSchema.parse({
    text: "покажи клієнтів",
    action: "customers.listCustomers",
    kind: "read",
    effect: "read",
    confirm: "none",
    params: {},
    needs: [],
    ready: true,
    catalogued: true,
    confidence: { action: 0.99, margin: 0.5, certainty: 0.9, spans: 0.9 },
    refPrevious: {},
    ...fields,
  });
}

const createKate = commandOf({
  text: "створи клієнта Катя",
  action: "customers.createCustomer",
  kind: "write",
  effect: "write",
  confirm: "card",
  params: { new_name: { text: "Катя" } },
  creates: { type: "customer", name: "Катя" },
});

const asked = (text: string): ModelMessage => ({ role: "user", content: text });

interface Ran {
  readonly command: ShoCommand;
  readonly toolName: string;
  readonly result: unknown;
  readonly sessionId?: string;
}

function turn(text: string, ran: Ran): readonly ModelMessage[] {
  const toolCallId = `sho-1-${ran.toolName}-${text.length.toString()}`;
  const log: ShoTurnLog = {
    command: ran.command,
    sessionId: ran.sessionId ?? SESSION,
    at: AT,
  };
  return [
    asked(text),
    {
      role: "assistant",
      providerOptions: shoLogOptions(log),
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: ran.toolName,
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: ran.toolName,
          output: { type: "json", value: ran.result as never },
        },
      ],
    },
    { role: "assistant", content: "Готово." },
  ];
}

const PAUSED = { status: "paused", reason: "confirmation" };

describe("shoTurnRecords", () => {
  it("takes a created record's id from what the façade returned", () => {
    expect(
      shoTurnRecords(createKate, CREATE_CUSTOMER_TOOL, {
        id: KATE,
        name: "Катя Самбука",
        phone: "+380501112233",
      }),
    ).toEqual([{ type: "customer", id: KATE, name: "Катя", how: "created" }]);
  });

  it("keeps a create still waiting on its card as a marker with no id", () => {
    expect(shoTurnRecords(createKate, CREATE_CUSTOMER_TOOL, undefined)).toEqual(
      [{ type: "customer", id: "", name: "Катя", how: "created" }],
    );
  });

  it("reads an order out of the page the façade answers a get with", () => {
    expect(
      shoTurnRecords(
        commandOf({ action: "orders.get", text: "покажи замовлення SHZ-1K4" }),
        ORDERS_LIST_PAGE_TOOL_NAME,
        {
          kind: "page.summary",
          requestedLimit: 20,
          rows: [{ orderId: ORDER, orderNumber: "SHZ-1K4", status: "new" }],
          hasMore: false,
          nextCursor: null,
        },
      ),
    ).toEqual([{ type: "order", id: ORDER, name: "SHZ-1K4", how: "listed" }]);
  });

  it("reads the created order out of the façade's own keys", () => {
    expect(
      shoTurnRecords(
        commandOf({
          action: "orders.create",
          kind: "write",
          effect: "write",
          confirm: "card",
          creates: { type: "order", name: null },
        }),
        ORDERS_CREATE_TOOL_NAME,
        { orderId: ORDER, orderNumber: "SHZ-1K4" },
      ),
    ).toEqual([{ type: "order", id: ORDER, name: "SHZ-1K4", how: "created" }]);
  });

  it("reads the record a card showed", () => {
    expect(
      shoTurnRecords(
        commandOf({ action: "customers.getCustomer" }),
        CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
        { id: OLHA, name: "Оля" },
      ),
    ).toEqual([{ type: "customer", id: OLHA, name: "Оля", how: "shown" }]);
  });

  it("binds the price list a settled card showed so the next pronoun resolves", () => {
    expect(
      shoTurnRecords(
        commandOf({ action: "pricing.getPriceList" }),
        GET_PRICE_LIST_TOOL,
        {
          id: PRICE_LIST,
          name: "Опт",
          isDefault: false,
          isActive: true,
          entryCount: 3,
        },
      ),
    ).toEqual([
      { type: "price_list", id: PRICE_LIST, name: "Опт", how: "shown" },
    ]);
  });

  it("keeps a long list as a marker so a later pronoun is offered, not bound", () => {
    expect(
      shoTurnRecords(commandOf({}), CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME, {
        items: [
          { id: KATE, name: "Катя" },
          { id: OLHA, name: "Оля" },
        ],
        nextCursor: null,
      }),
    ).toEqual([
      { type: "customer", id: "", name: "", how: "listed", count: 2 },
    ]);
  });

  it("keeps the one row a list found as that record", () => {
    expect(
      shoTurnRecords(commandOf({}), CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME, {
        items: [{ id: KATE, name: "Катя" }],
        nextCursor: null,
      }),
    ).toEqual([{ type: "customer", id: KATE, name: "Катя", how: "listed" }]);
  });

  it("holds the records the command itself named", () => {
    expect(
      shoTurnRecords(
        commandOf({
          action: "orders.list",
          params: {
            customer: {
              text: "Каті",
              status: "resolved",
              id: KATE,
              name: "Катя",
            },
            status: { value: "new" },
          },
        }),
        ORDERS_LIST_PAGE_TOOL_NAME,
        { kind: "page.summary", rows: [], hasMore: false, nextCursor: null },
      ),
    ).toContainEqual({
      type: "customer",
      id: KATE,
      name: "Катя",
      how: "named",
    });
  });

  it("reads nothing out of a tool whose records it does not know", () => {
    expect(shoTurnRecords(commandOf({}), "orders_list_counts", {})).toEqual([]);
  });
});

describe("shoFocusFrom", () => {
  const createdKate = turn("створи клієнта Катя", {
    command: createKate,
    toolName: CREATE_CUSTOMER_TOOL,
    result: { id: KATE, name: "Катя" },
  });
  const shownOlha = turn("знайди Олю", {
    command: commandOf({ action: "customers.getCustomer" }),
    toolName: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
    result: { id: OLHA, name: "Оля" },
  });

  it("gives the records of the stored log, newest first, with the commands since", () => {
    expect(shoFocusFrom([...createdKate, ...shownOlha], SESSION)).toEqual([
      { type: "customer", id: OLHA, name: "Оля", how: "shown", turns: 0 },
      { type: "customer", id: KATE, name: "Катя", how: "created", turns: 1 },
    ]);
  });

  it("holds one entry per record, the newest touch of it", () => {
    const shownKate = turn("знайди Катю", {
      command: commandOf({ action: "customers.getCustomer" }),
      toolName: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
      result: { id: KATE, name: "Катя" },
    });

    expect(shoFocusFrom([...createdKate, ...shownKate], SESSION)).toEqual([
      { type: "customer", id: KATE, name: "Катя", how: "shown", turns: 0 },
    ]);
  });

  it("carries the price list a card settled on into the next turn's focus", () => {
    const shownOpt = turn("покажи прайс Опт", {
      command: commandOf({ action: "pricing.getPriceList" }),
      toolName: GET_PRICE_LIST_TOOL,
      result: {
        id: PRICE_LIST,
        name: "Опт",
        isDefault: false,
        isActive: true,
        entryCount: 3,
      },
    });

    expect(shoFocusFrom(shownOpt, SESSION)).toEqual([
      {
        type: "price_list",
        id: PRICE_LIST,
        name: "Опт",
        how: "shown",
        turns: 0,
      },
    ]);
  });

  it("keeps one marker per kind, so markers cannot crowd out records", () => {
    const listed = (text: string): readonly ModelMessage[] =>
      turn(text, {
        command: commandOf({}),
        toolName: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
        result: {
          items: [
            { id: KATE, name: "Катя" },
            { id: OLHA, name: "Оля" },
          ],
          nextCursor: null,
        },
      });

    expect(
      shoFocusFrom(
        [...createdKate, ...listed("покажи клієнтів"), ...listed("ще раз")],
        SESSION,
      ),
    ).toEqual([
      { type: "customer", id: "", name: "", how: "listed", count: 2, turns: 0 },
      { type: "customer", id: KATE, name: "Катя", how: "created", turns: 2 },
    ]);
  });

  it("marks what another session touched, so it is offered and never bound", () => {
    const earlier = turn("знайди Олю", {
      command: commandOf({ action: "customers.getCustomer" }),
      toolName: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
      result: { id: OLHA, name: "Оля" },
      sessionId: OTHER_SESSION,
    });

    expect(shoFocusFrom(earlier, SESSION)).toEqual([
      {
        type: "customer",
        id: OLHA,
        name: "Оля",
        how: "shown",
        turns: 0,
        earlier: true,
      },
    ]);
  });

  it("sends at most the records the protocol allows", () => {
    const many = Array.from({ length: SHO_MOST_FOCUS + 3 }, (_, index) =>
      turn(`знайди ${String(index)}`, {
        command: commandOf({ action: "customers.getCustomer" }),
        toolName: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
        result: { id: `c-${String(index)}`, name: `Клієнт ${String(index)}` },
      }),
    ).flat();

    expect(shoFocusFrom(many, SESSION)).toHaveLength(SHO_MOST_FOCUS);
  });

  it("holds the order a card showed, so «скасуй його» has an id", () => {
    const shown = turn("покажи замовлення SHZ-1K4", {
      command: commandOf({
        action: "orders.get",
        text: "покажи замовлення SHZ-1K4",
      }),
      toolName: ORDERS_LIST_PAGE_TOOL_NAME,
      result: {
        kind: "page.summary",
        requestedLimit: 20,
        rows: [{ orderId: ORDER, orderNumber: "SHZ-1K4", status: "new" }],
        hasMore: false,
        nextCursor: null,
      },
    });

    expect(shoFocusFrom([...shown, asked("скасуй його")], SESSION)).toEqual([
      { type: "order", id: ORDER, name: "SHZ-1K4", how: "listed", turns: 1 },
    ]);
  });

  it("reads nothing from a conversation it was not given", () => {
    expect(shoFocusFrom(createdKate, SESSION).map((one) => one.id)).toEqual([
      KATE,
    ]);
    expect(shoFocusFrom(shownOlha, SESSION).map((one) => one.id)).toEqual([
      OLHA,
    ]);
  });

  it("reads nothing from a message that carries no stored turn", () => {
    expect(
      shoFocusFrom(
        [asked("привіт"), { role: "assistant", content: "Вітаю." }],
        SESSION,
      ),
    ).toEqual([]);
  });

  it("ignores a stored turn that no longer parses", () => {
    const history: readonly ModelMessage[] = [
      asked("покажи клієнтів"),
      {
        role: "assistant",
        providerOptions: { sho: { turn: '{"sessionId":"s"}' } },
        content: "Ось.",
      },
    ];

    expect(shoFocusFrom(history, SESSION)).toEqual([]);
  });

  it("drops the card the person walked away from", () => {
    const abandoned = [
      ...turn("створи клієнта Катя", {
        command: createKate,
        toolName: CREATE_CUSTOMER_TOOL,
        result: PAUSED,
      }),
      asked("покажи клієнтів"),
    ];

    expect(shoFocusFrom(abandoned, SESSION)).toEqual([]);
    expect(shoPreviousFrom(abandoned)).toBeUndefined();
  });

  it("holds nothing for a write that only ever paused", () => {
    const waiting = turn("створи клієнта Катя", {
      command: createKate,
      toolName: CREATE_CUSTOMER_TOOL,
      result: PAUSED,
    });

    expect(shoFocusFrom(waiting, SESSION)).toEqual([]);
  });
});

describe("shoPreviousFrom", () => {
  const read = commandOf({ action: "orders.list" });

  it("gives the last read, so a refinement has something to refine", () => {
    const history = turn("покажи замовлення", {
      command: read,
      toolName: ORDERS_LIST_PAGE_TOOL_NAME,
      result: { kind: "page.summary", rows: [], nextCursor: null },
    });

    expect(shoPreviousFrom(history)).toEqual({ command: read, at: AT });
  });

  it("gives nothing after a write the person confirmed", () => {
    const history = turn("створи клієнта Катя", {
      command: createKate,
      toolName: CREATE_CUSTOMER_TOOL,
      result: { id: KATE, name: "Катя" },
    });

    expect(shoPreviousFrom(history)).toBeUndefined();
  });

  it("gives nothing for a write whose card was never answered", () => {
    const history = turn("створи клієнта Катя", {
      command: createKate,
      toolName: CREATE_CUSTOMER_TOOL,
      result: PAUSED,
    });

    expect(shoPreviousFrom(history)).toBeUndefined();
  });

  it("gives nothing when the conversation holds no Шо turn", () => {
    expect(shoPreviousFrom([asked("привіт")])).toBeUndefined();
  });
});
