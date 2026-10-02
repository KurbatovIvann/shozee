import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoParam,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner } from "../sho-plan.js";
import type { ShoPlan } from "../sho-turn.js";

import { SHO_READ_ACTIONS, SHO_READ_PLANNERS } from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const CUSTOMER_ID = "0f6c8ef2-6b4c-4b2a-9f3e-5b1a6c2d7e81";
const ORDER_ID = "2a9d4c11-7f3b-4d54-8c21-9e7f0b3a5d64";
const PRODUCT_ID = "7c1b5d90-2e44-4a1f-8b6d-3f0c9a2e4b57";

interface Said {
  readonly text: string;
  readonly action: string;
  readonly params?: Readonly<Record<string, ShoParam>>;
  readonly kind?: string;
  readonly effect?: string;
  readonly confirm?: string;
}

function commandOf(said: Said): ShoCommand {
  return shoCommandSchema.parse({
    text: said.text,
    action: said.action,
    kind: said.kind ?? "read",
    effect: said.effect ?? "read",
    confirm: said.confirm ?? "none",
    params: said.params ?? {},
    needs: [],
    ready: true,
    catalogued: true,
    confidence: { action: 0.99, margin: 0.8, certainty: 0.9, spans: 0.9 },
    refPrevious: {},
  });
}

function resultOf(said: Said): ShoResult {
  const command = commandOf(said);
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: said.text,
    segments: [said.text],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 1, revision: null },
  });
}

function planOf(said: Said): ShoPlan {
  const planner = SHO_READ_PLANNERS[said.action];
  if (planner === undefined) {
    throw new Error(`no planner for ${said.action}`);
  }
  return planner.plan(commandOf(said), NOW);
}

const resolved = (id: string, text: string): ShoParam => ({
  text,
  status: "resolved",
  id,
});

describe("SHO_READ_PLANNERS maps the SHO-734 read phrases", () => {
  it("plans «покажи замовлення за минулий тиждень» as a dated page", () => {
    expect(
      planOf({
        text: "покажи замовлення за минулий тиждень",
        action: "orders.list",
        params: { period: { value: "last_week" } },
      }),
    ).toEqual({
      kind: "call",
      toolName: "orders_list_page",
      input: {
        createdFrom: "2026-08-23T21:00:00.000Z",
        createdTo: "2026-08-30T20:59:59.999Z",
      },
      reply: "Ось замовлення.",
    });
  });

  it("plans «покажи замовлення для Шерлока» by resolved customer id", () => {
    expect(
      planOf({
        text: "покажи замовлення для Шерлока",
        action: "orders.list",
        params: { customer: resolved(CUSTOMER_ID, "Шерлок") },
      }),
    ).toMatchObject({
      toolName: "orders_list_page",
      input: { customerIds: [CUSTOMER_ID] },
    });
  });

  it("plans an ambiguous customer as a query so the picker opens", () => {
    expect(
      planOf({
        text: "які у нас є замовлення для Шерлока",
        action: "orders.list",
        params: {
          customer: {
            text: "Шерлок",
            status: "ambiguous",
            candidates: [
              { id: CUSTOMER_ID, name: "Шерлок Холмс" },
              { id: ORDER_ID, name: "Шерлок Пекарня" },
            ],
          },
        },
      }),
    ).toMatchObject({
      toolName: "orders_list_page",
      input: { query: "Шерлок" },
    });
  });

  it("plans «скільки у нас підтверджених замовлень» as a status rollup", () => {
    expect(
      planOf({
        text: "скільки у нас підтверджених замовлень",
        action: "orders.count",
        params: { status: { value: "confirmed" } },
      }),
    ).toEqual({
      kind: "call",
      toolName: "orders_list_counts",
      input: { groupBy: "status", statuses: ["confirmed"] },
      reply: "Ось підсумок.",
    });
  });

  it("plans a counted period and customer together", () => {
    expect(
      planOf({
        text: "скільки замовлень від Coffee Time за вчора",
        action: "orders.count",
        params: {
          period: { value: "yesterday" },
          customer: resolved(CUSTOMER_ID, "Coffee Time"),
        },
      }),
    ).toMatchObject({
      toolName: "orders_list_counts",
      input: {
        groupBy: "status",
        createdFrom: "2026-08-31T21:00:00.000Z",
        createdTo: "2026-09-01T20:59:59.999Z",
        customerIds: [CUSTOMER_ID],
      },
    });
  });

  it("plans a resolved order as the order card", () => {
    expect(
      planOf({
        text: "покажи замовлення 24",
        action: "orders.get",
        params: { order: resolved(ORDER_ID, "24") },
      }),
    ).toEqual({
      kind: "call",
      toolName: "orders_get",
      input: { orderId: ORDER_ID },
      reply: "Ось замовлення.",
    });
  });

  it("sends «Відкрий замовлення номер 133» to the model: no order id", () => {
    expect(
      planOf({
        text: "Відкрий замовлення номер 133",
        action: "orders.get",
        params: { order: { text: "133", status: "unchecked" } },
      }),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("plans «покажи клієнта Альбіна» by id", () => {
    expect(
      planOf({
        text: "покажи клієнта Альбіна",
        action: "customers.getCustomer",
        params: { customer: resolved(CUSTOMER_ID, "Альбіна") },
      }),
    ).toEqual({
      kind: "call",
      toolName: "customers_get_customer",
      input: { customerId: CUSTOMER_ID },
      reply: "Ось клієнт.",
    });
  });

  it("plans «знайди клієнта Коваленко» as a query when nearest is offered", () => {
    expect(
      planOf({
        text: "знайди клієнта Коваленко",
        action: "customers.getCustomer",
        params: {
          customer: {
            text: "Коваленко",
            status: "unknown",
            nearest: [{ id: CUSTOMER_ID, name: "Коваленко Ірина", score: 0.8 }],
          },
        },
      }),
    ).toMatchObject({
      toolName: "customers_get_customer",
      input: { customerQuery: "Коваленко" },
    });
  });

  it("plans the customer list with no filter", () => {
    expect(
      planOf({ text: "покажи клієнтів", action: "customers.listCustomers" }),
    ).toEqual({
      kind: "call",
      toolName: "customers_list_customers",
      input: {},
      reply: "Ось клієнти.",
    });
  });

  it("plans «покажи макарон» as the product card", () => {
    expect(
      planOf({
        text: "покажи макарон",
        action: "catalog.getProduct",
        params: { product: resolved(PRODUCT_ID, "Макарон") },
      }),
    ).toEqual({
      kind: "call",
      toolName: "catalog_get_product",
      input: { productId: PRODUCT_ID },
      reply: "Ось товар.",
    });
  });

  it("plans the product list with a spoken query", () => {
    expect(
      planOf({
        text: "покажи товари торти",
        action: "catalog.listProducts",
        params: { query: { text: " торти " } },
      }),
    ).toEqual({
      kind: "call",
      toolName: "catalog_list_products",
      input: { query: "торти" },
      reply: "Ось товари.",
    });
  });

  it("plans the price lists with no filter", () => {
    expect(
      planOf({ text: "покажи прайс-листи", action: "pricing.listPriceLists" }),
    ).toEqual({
      kind: "call",
      toolName: "pricing_list_price_lists",
      input: {},
      reply: "Ось прайс-листи.",
    });
  });
});

describe("SHO_READ_PLANNERS falls back to the model", () => {
  const cases: readonly (Said & { readonly reason: string })[] = [
    {
      text: "покажи останні 5 замовлень",
      action: "orders.list",
      params: { limit: { text: "5", value: 5 } },
      reason: "unsupported_param",
    },
    {
      text: "покажи замовлення за минулу неділю",
      action: "orders.list",
      params: { period: { value: "минула неділя" } },
      reason: "unsupported_param",
    },
    {
      text: "скільки у нас замовлень які були відхилені",
      action: "orders.count",
      params: { status: { value: "rejected" } },
      reason: "unsupported_param",
    },
    {
      text: "покажи замовлення для тієї ж",
      action: "orders.list",
      params: { customer: { text: "тієї ж", status: "previous" } },
      reason: "conversation_dependent",
    },
    {
      text: "покажи клієнта",
      action: "customers.getCustomer",
      params: { customer: { text: "", status: "resolved", id: "" } },
      reason: "unresolved_reference",
    },
    {
      text: "покажи товари за групою",
      action: "catalog.listProducts",
      params: { group: { text: "торти" } },
      reason: "unsupported_param",
    },
  ];

  it.each(cases)("$text", (said) => {
    expect(planOf(said)).toEqual({ kind: "fallback", reason: said.reason });
  });
});

describe("read planners never take a write", () => {
  it("declares writes false for every registered read", () => {
    for (const action of SHO_READ_ACTIONS) {
      expect(SHO_READ_PLANNERS[action]?.writes).toBe(false);
    }
  });

  it("refuses a write-kind parse of a read action", () => {
    const planner = createShoPlanner({ actions: [...SHO_READ_ACTIONS] });
    expect(
      planner(
        resultOf({
          text: "видали замовлення 24",
          action: "orders.get",
          kind: "write",
          effect: "destructive",
          confirm: "strong",
          params: { order: resolved(ORDER_ID, "24") },
        }),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans a whitelisted read end to end through the gate", () => {
    const planner = createShoPlanner({ actions: [...SHO_READ_ACTIONS] });
    expect(
      planner(
        resultOf({
          text: "покажи замовлення за місяць",
          action: "orders.list",
          params: { period: { value: "this_month" } },
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "call", toolName: "orders_list_page" });
  });

  it("sends an action outside the deployment whitelist to the model", () => {
    const planner = createShoPlanner({ actions: ["orders.list"] });
    expect(
      planner(
        resultOf({
          text: "покажи прайс-листи",
          action: "pricing.listPriceLists",
        }),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});
