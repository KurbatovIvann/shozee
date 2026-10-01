import { describe, expect, it } from "vitest";

import {
  planShoTurn,
  SHO_ORDERS_CREATE_TOOL,
  SHO_ORDERS_LIST_TOOL,
  type ShoCommand,
  type ShoResult,
} from "./sho-plan.js";

const SURE = { action: 0.99, margin: 0.9, spans: 0.95 };
const NOW = new Date("2026-09-29T09:00:00.000Z");

function planned(given: ShoResult) {
  return planShoTurn(given, NOW);
}

function result(command: Partial<ShoCommand>): ShoResult {
  return {
    tooMany: false,
    commands: [
      {
        action: "orders.list",
        params: {},
        needs: [],
        confidence: SURE,
        ...command,
      },
    ],
  };
}

describe("planShoTurn", () => {
  it("maps a period to an inclusive Kyiv day interval", () => {
    const made = planned(
      result({
        action: "orders.list",
        params: { period: { value: "yesterday" } },
      }),
    );
    expect(made).toEqual({
      kind: "read",
      toolName: SHO_ORDERS_LIST_TOOL,
      input: {
        createdFrom: "2026-09-27T21:00:00.000Z",
        createdTo: "2026-09-28T20:59:59.999Z",
      },
    });
  });

  it("passes a resolved customer as an id, never as a query", () => {
    const made = planned(
      result({
        params: {
          customer: {
            text: "Олені",
            status: "resolved",
            id: "11111111-1111-4111-8111-111111111111",
          },
        },
      }),
    );
    expect(made).toMatchObject({
      kind: "read",
      input: { customerIds: ["11111111-1111-4111-8111-111111111111"] },
    });
  });

  it("turns an ambiguous customer into a choice carrying Шо's candidates", () => {
    const made = planned(
      result({
        needs: [{ path: "customer", reason: "ambiguous", blocking: true }],
        params: {
          customer: {
            text: "Олена",
            status: "ambiguous",
            candidates: [
              { id: "a", name: "Олена Коваль" },
              { id: "b", name: "Олена Шевченко" },
            ],
          },
        },
      }),
    );
    expect(made).toMatchObject({
      kind: "choice",
      subject: "Олена",
      options: [
        { optionId: "a", label: "Олена Коваль" },
        { optionId: "b", label: "Олена Шевченко" },
      ],
      optionsTruncated: false,
    });
  });

  it("maps a create with resolved lines to the orders_create façade input", () => {
    const made = planned(
      result({
        action: "orders.create",
        params: {
          customer: { text: "Олени", status: "resolved", id: "cust-1" },
          items: [
            {
              product: { text: "медових тортів", status: "resolved", id: "p1" },
              variant: { status: "none" },
              quantity: { value: 2 },
            },
          ],
        },
      }),
    );
    expect(made).toEqual({
      kind: "write",
      toolName: SHO_ORDERS_CREATE_TOOL,
      input: {
        customerId: "cust-1",
        items: [{ productId: "p1", quantityDecimal: "2.000" }],
      },
    });
  });

  it.each([
    [
      "low_confidence",
      result({ confidence: { action: 0.4, margin: 0.1, spans: 0.9 } }),
    ],
    ["not_whitelisted", result({ action: "stock.receive" })],
    ["many_commands", { tooMany: true, commands: [] } satisfies ShoResult],
    ["no_command", { tooMany: false, commands: [] } satisfies ShoResult],
    [
      "unsupported_param",
      result({ params: { due: { text: "завтра", value: {} } } }),
    ],
    [
      "unresolved_reference",
      result({
        params: { customer: { text: "Хтось", status: "unknown" } },
      }),
    ],
    [
      "blocking_need",
      result({
        needs: [{ path: "items", reason: "missing", blocking: true }],
      }),
    ],
  ])("falls back with %s", (reason, given) => {
    expect(planned(given)).toEqual({ kind: "fallback", reason });
  });

  it("keeps a non-blocking need out of the fallback decision", () => {
    expect(
      planned(
        result({
          needs: [{ path: "text", reason: "unparsed", blocking: false }],
        }),
      ),
    ).toMatchObject({ kind: "read" });
  });
});
