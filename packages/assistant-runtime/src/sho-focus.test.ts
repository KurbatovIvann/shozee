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
  type ShoFocusRecord,
  type ShoTurnLog,
} from "./sho-focus.js";

const SESSION = "6a1d0f72-2c44-4a0b-9f31-5d8e2b7c4a10";
const OTHER_SESSION = "0b9c7e55-13aa-4f28-8c60-9e4d1a3f7b22";
const AT = "2026-10-02T09:00:00.000Z";

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

const asked = (text: string): ModelMessage => ({ role: "user", content: text });

function logged(log: ShoTurnLog): ModelMessage {
  return {
    role: "assistant",
    providerOptions: shoLogOptions(log),
    content: [
      {
        type: "tool-call",
        toolCallId: "sho-1-tool-command",
        toolName: "customers_list_customers",
        input: {},
      },
    ],
  };
}

function turn(
  text: string,
  log: Omit<ShoTurnLog, "sessionId" | "at"> &
    Partial<Pick<ShoTurnLog, "sessionId" | "at">>,
): readonly ModelMessage[] {
  return [
    asked(text),
    logged({ sessionId: SESSION, at: AT, ...log }),
    { role: "assistant", content: "Готово." },
  ];
}

const KATE: ShoFocusRecord = {
  type: "customer",
  id: "11111111-1111-4111-8111-111111111111",
  name: "Катя",
  how: "created",
};

const OLHA: ShoFocusRecord = {
  type: "customer",
  id: "22222222-2222-4222-8222-222222222222",
  name: "Оля",
  how: "shown",
};

describe("shoTurnRecords", () => {
  it("takes a created record's id from what the write returned", () => {
    const records = shoTurnRecords(
      commandOf({
        action: "customers.createCustomer",
        kind: "write",
        effect: "write",
        confirm: "card",
        creates: { type: "customer", name: "Катя" },
      }),
      { id: KATE.id, name: "Катя Самбука", phone: "+380501112233" },
    );

    expect(records).toEqual([
      { type: "customer", id: KATE.id, name: "Катя", how: "created" },
    ]);
  });

  it("keeps a create the action refused as a marker with no id", () => {
    const records = shoTurnRecords(
      commandOf({
        action: "customers.createCustomer",
        kind: "write",
        effect: "write",
        confirm: "card",
        creates: { type: "customer", name: "Катя" },
      }),
      null,
    );

    expect(records).toEqual([
      { type: "customer", id: "", name: "Катя", how: "created" },
    ]);
  });

  it("reads the record a card showed", () => {
    expect(
      shoTurnRecords(commandOf({ action: "customers.getCustomer" }), {
        id: OLHA.id,
        name: "Оля",
      }),
    ).toEqual([{ type: "customer", id: OLHA.id, name: "Оля", how: "shown" }]);
  });

  it("reads an order by its number rather than its uuid field", () => {
    expect(
      shoTurnRecords(commandOf({ action: "orders.get" }), {
        orderId: "33333333-3333-4333-8333-333333333333",
        orderNumber: "SHZ-1K4",
      }),
    ).toEqual([
      {
        type: "order",
        id: "33333333-3333-4333-8333-333333333333",
        name: "SHZ-1K4",
        how: "shown",
      },
    ]);
  });

  it("keeps a long list as a marker so a later pronoun is offered, not bound", () => {
    expect(
      shoTurnRecords(commandOf({ action: "customers.listCustomers" }), {
        items: [
          { id: KATE.id, name: "Катя" },
          { id: OLHA.id, name: "Оля" },
        ],
        nextCursor: null,
      }),
    ).toEqual([
      { type: "customer", id: "", name: "", how: "listed", count: 2 },
    ]);
  });

  it("keeps the one row a list found as that record", () => {
    expect(
      shoTurnRecords(commandOf({ action: "catalog.listProducts" }), {
        items: [{ id: "p-1", name: "Кава" }],
        nextCursor: null,
      }),
    ).toEqual([{ type: "product", id: "p-1", name: "Кава", how: "listed" }]);
  });

  it("holds the records the command itself named", () => {
    const records = shoTurnRecords(
      commandOf({
        action: "orders.list",
        params: {
          customer: {
            text: "Каті",
            status: "resolved",
            id: KATE.id,
            name: "Катя",
          },
          status: { value: "new" },
        },
      }),
      { items: [], nextCursor: null },
    );

    expect(records).toContainEqual({
      type: "customer",
      id: KATE.id,
      name: "Катя",
      how: "named",
    });
  });

  it("names nothing for a reference the parse did not resolve", () => {
    expect(
      shoTurnRecords(
        commandOf({
          action: "orders.list",
          params: { customer: { text: "Катя", status: "ambiguous" } },
        }),
        { items: [], nextCursor: null },
      ),
    ).toEqual([{ type: "order", id: "", name: "", how: "listed", count: 0 }]);
  });
});

describe("shoFocusFrom", () => {
  it("gives the records of the stored log, newest first, with the commands since", () => {
    const history = [
      ...turn("створи клієнта Катя", {
        command: commandOf({}),
        records: [KATE],
        open: false,
      }),
      ...turn("знайди Олю", {
        command: commandOf({}),
        records: [OLHA],
        open: false,
      }),
    ];

    expect(shoFocusFrom(history, SESSION)).toEqual([
      { ...OLHA, turns: 0 },
      { ...KATE, turns: 1 },
    ]);
  });

  it("holds one entry per record, the newest touch of it", () => {
    const history = [
      ...turn("створи клієнта Катя", {
        command: commandOf({}),
        records: [KATE],
        open: false,
      }),
      ...turn("знайди Катю", {
        command: commandOf({}),
        records: [{ ...KATE, how: "shown" }],
        open: false,
      }),
    ];

    expect(shoFocusFrom(history, SESSION)).toEqual([
      { ...KATE, how: "shown", turns: 0 },
    ]);
  });

  it("marks what another session touched, so it is offered and never bound", () => {
    const history = turn("знайди Олю", {
      command: commandOf({}),
      records: [OLHA],
      open: false,
      sessionId: OTHER_SESSION,
    });

    expect(shoFocusFrom(history, SESSION)).toEqual([
      { ...OLHA, turns: 0, earlier: true },
    ]);
  });

  it("sends at most the records the protocol allows", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      type: "customer" as const,
      id: `c-${String(index)}`,
      name: `Клієнт ${String(index)}`,
      how: "listed" as const,
    }));
    const history = turn("покажи клієнтів", {
      command: commandOf({}),
      records: many.slice(0, SHO_MOST_FOCUS),
      open: false,
    });

    expect(shoFocusFrom(history, SESSION)).toHaveLength(SHO_MOST_FOCUS);
  });

  it("reads nothing from a conversation it was not given", () => {
    const mine = turn("створи клієнта Катя", {
      command: commandOf({}),
      records: [KATE],
      open: false,
    });
    const theirs = turn("створи клієнта Оля", {
      command: commandOf({}),
      records: [OLHA],
      open: false,
    });

    expect(shoFocusFrom(mine, SESSION).map((entry) => entry.id)).toEqual([
      KATE.id,
    ]);
    expect(shoFocusFrom(theirs, SESSION).map((entry) => entry.id)).toEqual([
      OLHA.id,
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
        providerOptions: { sho: { turn: '{"records":[]}' } },
        content: "Ось.",
      },
    ];

    expect(shoFocusFrom(history, SESSION)).toEqual([]);
  });
});

describe("shoPreviousFrom", () => {
  const read = commandOf({ action: "orders.list" });
  const write = commandOf({
    action: "customers.createCustomer",
    kind: "write",
    effect: "write",
    confirm: "card",
  });

  it("gives the last read, so a refinement has something to refine", () => {
    const history = turn("покажи замовлення", {
      command: read,
      records: [],
      open: false,
    });

    expect(shoPreviousFrom(history)).toEqual({ command: read, at: AT });
  });

  it("gives nothing after a write", () => {
    const history = turn("створи клієнта Катя", {
      command: write,
      records: [KATE],
      open: false,
    });

    expect(shoPreviousFrom(history)).toBeUndefined();
  });

  it("gives the command of a card that is still open", () => {
    const history = turn("створи клієнта Катя", {
      command: write,
      records: [KATE],
      open: true,
    });

    expect(shoPreviousFrom(history)).toEqual({ command: write, at: AT });
  });

  it("gives nothing when the conversation holds no Шо turn", () => {
    expect(shoPreviousFrom([asked("привіт")])).toBeUndefined();
  });
});
