import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoParam,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import {
  SHO_READ_ACTIONS,
  SHO_READ_PLANNER_PARAMS,
  SHO_READ_PLANNERS,
} from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const CUSTOMER_ID = "0f6c8ef2-6b4c-4b2a-9f3e-5b1a6c2d7e81";
const GROUP_ID = "2a9d4c11-7f3b-4d54-8c21-9e7f0b3a5d64";
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

function planOf(said: Said): ShoActionPlan {
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
              { id: GROUP_ID, name: "Шерлок Пекарня" },
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

  it("plans «скільки замовлень від Coffee Time за вчора по продуктах»", () => {
    expect(
      planOf({
        text: "скільки замовлень від Coffee Time за вчора по продуктах",
        action: "orders.count",
        params: {
          period: { value: "yesterday" },
          customer: resolved(CUSTOMER_ID, "Coffee Time"),
          group_by: { value: "product" },
        },
      }),
    ).toMatchObject({
      toolName: "orders_list_counts",
      input: {
        groupBy: "product",
        createdFrom: "2026-08-31T21:00:00.000Z",
        createdTo: "2026-09-01T20:59:59.999Z",
        customerIds: [CUSTOMER_ID],
      },
    });
  });

  it("plans «скільки у нас активних замовлень» as the active set", () => {
    expect(
      planOf({
        text: "скільки у нас активних замовлень",
        action: "orders.count",
        params: { status: { value: "active" } },
      }),
    ).toMatchObject({
      input: { statuses: ["new", "confirmed", "in_progress"] },
    });
  });

  it("plans a canonical order number as the orders page query", () => {
    expect(
      planOf({
        text: "Відкрий замовлення SP-1A33",
        action: "orders.get",
        params: { order_number: { text: "SP-1A33", value: 133 } },
      }),
    ).toEqual({
      kind: "call",
      toolName: "orders_list_page",
      input: { query: "SP-1A33" },
      reply: "Ось замовлення.",
    });
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

  it("plans «знайди клієнта з номером 067 123 45 67» by the phone span", () => {
    expect(
      planOf({
        text: "знайди клієнта з номером 067 123 45 67",
        action: "customers.getCustomer",
        params: { phone: { text: "067 123 45 67" } },
      }),
    ).toMatchObject({
      toolName: "customers_get_customer",
      input: { customerQuery: "067 123 45 67" },
    });
  });

  it("plans «покажи клієнтів групи VIP» by resolved group id", () => {
    expect(
      planOf({
        text: "покажи клієнтів групи VIP",
        action: "customers.listCustomers",
        params: { group: resolved(GROUP_ID, "VIP") },
      }),
    ).toEqual({
      kind: "call",
      toolName: "customers_list_customers",
      input: { groupId: GROUP_ID },
      reply: "Ось клієнти.",
    });
  });

  it("plans «покажи архівних клієнтів Київ» as search plus status", () => {
    expect(
      planOf({
        text: "покажи архівних клієнтів Київ",
        action: "customers.listCustomers",
        params: {
          search_text: { text: " Київ " },
          status: { value: "archived" },
        },
      }),
    ).toMatchObject({
      toolName: "customers_list_customers",
      input: { search: "Київ", status: "archived" },
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

  it("plans the product list with a spoken search", () => {
    expect(
      planOf({
        text: "покажи товари торти",
        action: "catalog.listProducts",
        params: { search_text: { text: "торти" } },
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

  it("clips a long search to the façade maximum", () => {
    const plan = planOf({
      text: "покажи товари",
      action: "catalog.listProducts",
      params: { search_text: { text: "я".repeat(500) } },
    });
    const query = plan.kind === "call" ? plan.input["query"] : null;
    expect(typeof query === "string" ? query.length : 0).toBeLessThanOrEqual(
      200,
    );
  });
});

describe("SHO_READ_PLANNERS falls back to the model", () => {
  const cases: readonly (Said & { readonly reason: string })[] = [
    {
      text: "покажи замовлення які треба віддати завтра",
      action: "orders.list",
      params: { due: { text: "завтра" } },
      reason: "unsupported_param",
    },
    {
      text: "покажи неоплачені замовлення",
      action: "orders.list",
      params: { payment_status: { value: "unpaid" } },
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
      text: "скільки замовлень по днях",
      action: "orders.count",
      params: { group_by: { value: "day" } },
      reason: "unsupported_param",
    },
    {
      text: "покажи замовлення для тієї ж",
      action: "orders.list",
      params: { customer: { text: "тієї ж", status: "previous" } },
      reason: "conversation_dependent",
    },
    {
      text: "покажи замовлення SP-1A33 для Шерлока",
      action: "orders.get",
      params: {
        order_number: { text: "SP-1A33", value: 133 },
        customer: {
          text: "Шерлок",
          status: "ambiguous",
          candidates: [
            { id: CUSTOMER_ID, name: "Шерлок Холмс" },
            { id: GROUP_ID, name: "Шерлок Пекарня" },
          ],
        },
      },
      reason: "unsupported_param",
    },
    {
      text: "покажи клієнта Альбіна з номером 067 123 45 67",
      action: "customers.getCustomer",
      params: {
        customer: resolved(CUSTOMER_ID, "Альбіна"),
        phone: { text: "067 123 45 67" },
      },
      reason: "unsupported_param",
    },
    {
      text: "покажи клієнта",
      action: "customers.getCustomer",
      params: { customer: { text: "Оксана", status: "resolved", id: "c-17" } },
      reason: "unsupported_param",
    },
    {
      text: "покажи клієнтів групи",
      action: "customers.listCustomers",
      params: {
        group: {
          text: "VIP",
          status: "unknown",
          nearest: [{ id: GROUP_ID, name: "VIP клієнти", score: 0.7 }],
        },
      },
      reason: "unsupported_param",
    },
    {
      text: "Відкрий замовлення номер 133",
      action: "orders.get",
      params: { order_number: { text: "133", value: 133 } },
      reason: "unsupported_param",
    },
    {
      text: "покажи активні прайс-листи",
      action: "pricing.listPriceLists",
      params: { availability: { value: "active" } },
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

  it("names the params it reads for every registered read", () => {
    expect(Object.keys(SHO_READ_PLANNER_PARAMS)).toEqual([...SHO_READ_ACTIONS]);
    for (const names of Object.values(SHO_READ_PLANNER_PARAMS)) {
      expect(names.length).toBeGreaterThan(0);
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
          params: { order_number: { text: "SP-0024", value: 24 } },
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
