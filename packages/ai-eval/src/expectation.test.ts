import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "@showzy/ai";
import { describe, expect, it } from "vitest";

import {
  isNominativeKatyaSambukaSearch,
  matchEvalExpectation,
} from "./expectation.js";
import { PROOF_SCENARIOS } from "./scenarios/proof.js";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

describe("isNominativeKatyaSambukaSearch", () => {
  it("accepts nominative Катя Самбука and rejects the utterance / genitive", () => {
    expect(isNominativeKatyaSambukaSearch("Катя Самбука")).toBe(true);
    expect(isNominativeKatyaSambukaSearch("катя самбука")).toBe(true);
    expect(isNominativeKatyaSambukaSearch("Каті Самбуки")).toBe(false);
    expect(isNominativeKatyaSambukaSearch("замовлення для Каті Самбуки")).toBe(
      false,
    );
    expect(
      isNominativeKatyaSambukaSearch("покажи замовлення Каті Самбуки"),
    ).toBe(false);
    expect(isNominativeKatyaSambukaSearch("замовлення")).toBe(false);
  });
});

describe("matchEvalExpectation", () => {
  it("passes a scripted counts trace and fails wrong tool, args, or order", () => {
    const counts = {
      text: "3",
      toolCalls: [
        {
          toolCallId: "c1",
          name: ORDERS_LIST_COUNTS_TOOL_NAME,
          args: { period: "today" },
        },
      ],
    };
    expect(
      matchEvalExpectation(
        {
          ordered: [
            { name: ORDERS_LIST_COUNTS_TOOL_NAME, args: { period: "today" } },
          ],
        },
        counts,
      ),
    ).toEqual({ ok: true });
    expect(
      matchEvalExpectation(
        { ordered: [{ name: ORDERS_LIST_PAGE_TOOL_NAME }] },
        counts,
      ),
    ).toMatchObject({ ok: false });
    expect(
      matchEvalExpectation(
        {
          ordered: [
            { name: ORDERS_LIST_COUNTS_TOOL_NAME, args: { period: "week" } },
          ],
        },
        counts,
      ),
    ).toMatchObject({ ok: false });
    expect(
      matchEvalExpectation(
        {
          ordered: [
            { name: ORDERS_LIST_PAGE_TOOL_NAME },
            { name: ORDERS_LIST_COUNTS_TOOL_NAME },
          ],
        },
        counts,
      ),
    ).toMatchObject({ ok: false });
  });

  it("matches Katya search then page by prior customer id", () => {
    const trace = {
      text: "1",
      toolCalls: [
        {
          toolCallId: "c1",
          name: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
          args: { search: "Катя Самбука" },
          result: { items: [{ id: CUSTOMER_ID, name: "Катя Самбука" }] },
        },
        {
          toolCallId: "c2",
          name: ORDERS_LIST_PAGE_TOOL_NAME,
          args: { customerIds: [CUSTOMER_ID] },
        },
      ],
    };
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.orders-for-katya",
    );
    expect(scenario).toBeDefined();
    expect(matchEvalExpectation(scenario?.expectation ?? {}, trace)).toEqual({
      ok: true,
    });
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, {
        text: "1",
        toolCalls: [
          {
            toolCallId: "c1",
            name: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
            args: { search: "покажи замовлення Каті Самбуки" },
            result: { items: [{ id: CUSTOMER_ID }] },
          },
          {
            toolCallId: "c2",
            name: ORDERS_LIST_PAGE_TOOL_NAME,
            args: { customerIds: [CUSTOMER_ID] },
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it("forbids customers.createCustomer on the create-order proof", () => {
    const scenario = PROOF_SCENARIOS.find(
      (entry) => entry.id === "proof.create-order-katya-napoleon",
    );
    expect(scenario).toBeDefined();
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, {
        text: "ok",
        toolCalls: [
          {
            toolCallId: "c1",
            name: ORDERS_CREATE_TOOL_NAME,
            args: {
              customerQuery: "Катя",
              items: [{ productQuery: "наполеон", quantityDecimal: "2" }],
            },
          },
        ],
      }),
    ).toEqual({ ok: true });
    expect(
      matchEvalExpectation(scenario?.expectation ?? {}, {
        text: "ok",
        toolCalls: [
          {
            toolCallId: "c0",
            name: "customers_createCustomer",
            args: { name: "Катя" },
          },
          {
            toolCallId: "c1",
            name: ORDERS_CREATE_TOOL_NAME,
            args: {
              customerQuery: "Катя",
              items: [{ productQuery: "наполеон", quantityDecimal: "2" }],
            },
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: "forbidden tool customers_createCustomer",
    });
  });

  it("accepts no tools for weather and tool_search first for capability", () => {
    expect(
      matchEvalExpectation(
        { none: true, maxTextChars: 400 },
        { text: "Я не прогнозую погоду.", toolCalls: [] },
      ),
    ).toEqual({ ok: true });
    expect(
      matchEvalExpectation(
        { none: true },
        {
          text: "ok",
          toolCalls: [
            { toolCallId: "c1", name: ORDERS_LIST_COUNTS_TOOL_NAME, args: {} },
          ],
        },
      ),
    ).toMatchObject({ ok: false });
    expect(
      matchEvalExpectation(
        { first: STAFF_ASSISTANT_TOOL_SEARCH_NAME },
        {
          text: "ok",
          toolCalls: [
            {
              toolCallId: "c1",
              name: STAFF_ASSISTANT_TOOL_SEARCH_NAME,
              args: { query: "help" },
            },
          ],
        },
      ),
    ).toEqual({ ok: true });
  });

  it("requires tool-result values in the final text, never phrasing", () => {
    const pageTrace = {
      text: "Ось три останні, найбільше — № 12",
      toolCalls: [
        {
          toolCallId: "c1",
          name: ORDERS_LIST_PAGE_TOOL_NAME,
          args: {},
          result: { rows: [{ orderNumber: "12" }] },
        },
      ],
    };
    expect(
      matchEvalExpectation(
        { textIncludesToolValues: ["orderNumber"] },
        pageTrace,
      ),
    ).toEqual({ ok: true });
    expect(
      matchEvalExpectation(
        { textIncludesToolValues: ["orderNumber"] },
        { ...pageTrace, text: "Останні замовлення." },
      ),
    ).toMatchObject({ ok: false });
    expect(
      matchEvalExpectation(
        { textIncludesToolValues: ["orderCount"] },
        {
          text: "Цього тижня 4.",
          toolCalls: [
            {
              toolCallId: "c1",
              name: ORDERS_LIST_COUNTS_TOOL_NAME,
              args: { period: "this_week" },
              result: { orderCount: 4 },
            },
          ],
        },
      ),
    ).toEqual({ ok: true });
    expect(
      matchEvalExpectation(
        { textIncludesToolValues: ["customerName"] },
        {
          text: "Знайшла Катю Самбуку.",
          toolCalls: [
            {
              toolCallId: "c1",
              name: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
              args: { search: "Катя" },
              result: { items: [{ name: "Катя Самбука" }] },
            },
          ],
        },
      ),
    ).toEqual({ ok: true });
  });
});
