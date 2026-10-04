import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoParam,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoReadParse } from "./__tests__/read-parses.js";
import {
  shoReadPlanners,
  SHO_READ_ACTIONS,
  SHO_READ_PLANNER_PARAMS,
  SHO_READ_PLANNERS,
  SHO_READ_TOOL_NAMES,
  SHO_SURFACED_READ_ACTIONS,
} from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const CUSTOMER_ID = "0f6c8ef2-6b4c-4b2a-9f3e-5b1a6c2d7e81";
const GROUP_ID = "2a9d4c11-7f3b-4d54-8c21-9e7f0b3a5d64";
const PRODUCT_ID = "7c1b5d90-2e44-4a1f-8b6d-3f0c9a2e4b57";
const PRICE_LIST_ID = "4d8e1a62-9c07-4f33-bb18-6a2d5e7c0913";
const COUNTERPARTY_ID = "b35f7e04-18ac-42d6-9c5b-71e8d0a4f236";

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

const COMPANY_IDS: Readonly<Record<string, string>> = {
  "g-institutions": GROUP_ID,
  "k-nechyporuk": COUNTERPARTY_ID,
  "pl-partner": PRICE_LIST_ID,
  "new-autumn": PRICE_LIST_ID,
};

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

interface GoldParse {
  readonly text: string;
  readonly action: string;
  readonly kind: string;
  readonly effect: string;
  readonly confirm: string;
  readonly params?: Readonly<Record<string, ShoParam>>;
}

const goldOf = (caseId: string, asCompanyRecords = true): GoldParse => {
  const parse = shoReadParse(caseId);
  return (asCompanyRecords ? reId(parse) : parse) as GoldParse;
};

function gold(caseId: string): Said {
  const parse = goldOf(caseId);
  return {
    text: parse.text,
    action: parse.action,
    kind: parse.kind,
    effect: parse.effect,
    confirm: parse.confirm,
    params: parse.params ?? {},
  };
}

function borrowed(
  caseId: string,
  action: string,
  names: readonly string[],
  asCompanyRecords = true,
): Said {
  const parse = goldOf(caseId, asCompanyRecords);
  const said = parse.params ?? {};
  return {
    text: parse.text,
    action,
    params: Object.fromEntries(
      names.map((name) => [name, said[name]]),
    ) as Record<string, ShoParam>,
  };
}

const everySurfaced = new Set(Object.values(SHO_READ_TOOL_NAMES));

const planAsIfSurfaced = (said: Said): ShoActionPlan => {
  const planner = shoReadPlanners(everySurfaced)[said.action];
  if (planner === undefined) {
    throw new Error(`no planner for ${said.action}`);
  }
  return planner.plan(commandOf(said), NOW);
};

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
      planAsIfSurfaced({
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
      planAsIfSurfaced({
        text: "покажи прайс-листи",
        action: "pricing.listPriceLists",
      }),
    ).toEqual({
      kind: "call",
      toolName: "pricing_list_price_lists",
      input: {},
      reply: "Ось прайс-листи.",
    });
  });

  it("clips a long search to the façade maximum", () => {
    const plan = planAsIfSurfaced({
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

describe("SHO_READ_PLANNERS plans only a surfaced read", () => {
  it("plans search from d72-stock-list's search text", () => {
    expect(
      planOf(borrowed("d72-stock-list", "search.query", ["search_text"])),
    ).toEqual({
      kind: "call",
      toolName: "search_query",
      input: { query: "болгарки" },
      reply: "Ось що знайшлося.",
    });
  });

  it("narrows search to one entity type Shozee searches", () => {
    const said = borrowed("d72-stock-list", "search.query", ["search_text"]);
    expect(
      planOf({
        ...said,
        params: { ...said.params, search_type: { value: "product" } },
      }),
    ).toMatchObject({
      toolName: "search_query",
      input: { query: "болгарки", types: ["product"] },
    });
  });

  const outcome = (plan: ShoActionPlan | undefined): string =>
    plan === undefined
      ? "none"
      : plan.kind === "fallback"
        ? plan.reason
        : plan.kind;

  const PLANNABLE: Readonly<Record<string, Said>> = {
    "customers.getCustomer": {
      text: "покажи клієнта цукерню",
      action: "customers.getCustomer",
      params: { customer: resolved(CUSTOMER_ID, "цукерню") },
    },
    "catalog.getProduct": {
      text: "покажи американо",
      action: "catalog.getProduct",
      params: { product: resolved(PRODUCT_ID, "американо") },
    },
    "customers.getGroup": borrowed("d79-group-case", "customers.getGroup", [
      "group",
    ]),
    "customers.getCounterparty": borrowed(
      "d79-counterparty-rest",
      "customers.getCounterparty",
      ["counterparty"],
    ),
    "pricing.getPriceList": gold("d89-open-price-list"),
    "pricing.listPriceListEntries": gold("d79-price-list-noun"),
    "search.query": borrowed("d72-stock-list", "search.query", ["search_text"]),
  };

  it.each([...SHO_READ_ACTIONS])(
    "%s plans a call only where its tool composes a surface",
    (action) => {
      const command = commandOf(
        PLANNABLE[action] ?? { text: "покажи", action },
      );
      const open = shoReadPlanners(everySurfaced)[action]?.plan(command, NOW);
      const live = SHO_READ_PLANNERS[action]?.plan(command, NOW);
      expect({ action, open: outcome(open), live: outcome(live) }).toEqual({
        action,
        open: "call",
        live: SHO_SURFACED_READ_ACTIONS.includes(action)
          ? "call"
          : "no_surface",
      });
    },
  );

  it("plans catalog.listProducts and pricing.listPriceLists now that their lists compose (SHO-865)", () => {
    expect([...SHO_SURFACED_READ_ACTIONS]).toEqual([
      "orders.list",
      "orders.count",
      "orders.get",
      "customers.getCustomer",
      "customers.listCustomers",
      "catalog.getProduct",
      "catalog.listProducts",
      "pricing.listPriceLists",
      "search.query",
    ]);
  });

  it("plans the products list instead of falling back to Haiku", () => {
    expect(
      SHO_READ_PLANNERS["catalog.listProducts"]?.plan(
        commandOf({ text: "покажи товари", action: "catalog.listProducts" }),
        NOW,
      ),
    ).toEqual({
      kind: "call",
      toolName: "catalog_list_products",
      input: {},
      reply: "Ось товари.",
    });
  });

  it("plans the price lists instead of falling back to Haiku", () => {
    expect(
      SHO_READ_PLANNERS["pricing.listPriceLists"]?.plan(
        commandOf({
          text: "покажи прайс-листи",
          action: "pricing.listPriceLists",
        }),
        NOW,
      ),
    ).toEqual({
      kind: "call",
      toolName: "pricing_list_price_lists",
      input: {},
      reply: "Ось прайс-листи.",
    });
  });
});

describe("the SHO-854 planners map their params for the surface to come", () => {
  it("plans d72-read-groups as the bare group list", () => {
    expect(planAsIfSurfaced(gold("d72-read-groups"))).toEqual({
      kind: "call",
      toolName: "customers_list_groups",
      input: {},
      reply: "Ось групи.",
    });
  });

  it("plans the group card from d79-group-case's resolved group", () => {
    expect(
      planAsIfSurfaced(
        borrowed("d79-group-case", "customers.getGroup", ["group"]),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_getGroup",
      input: { id: GROUP_ID },
      reply: "Ось група.",
    });
  });

  it("plans the counterparty list from d72-stock-list's search text", () => {
    expect(
      planAsIfSurfaced(
        borrowed("d72-stock-list", "customers.listCounterparties", [
          "search_text",
        ]),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_listCounterparties",
      input: { search: "болгарки" },
      reply: "Ось контрагенти.",
    });
  });

  it("plans the counterparties of a resolved customer by id", () => {
    expect(
      planAsIfSurfaced({
        text: "покажи контрагентів цукерні",
        action: "customers.listCounterparties",
        params: { customer: resolved(CUSTOMER_ID, "цукерні") },
      }),
    ).toMatchObject({
      toolName: "customers_listCounterparties",
      input: { customerId: CUSTOMER_ID },
    });
  });

  it("plans the counterparty card from d79-counterparty-rest's ref", () => {
    expect(
      planAsIfSurfaced(
        borrowed("d79-counterparty-rest", "customers.getCounterparty", [
          "counterparty",
        ]),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_getCounterparty",
      input: { id: COUNTERPARTY_ID },
      reply: "Ось контрагент.",
    });
  });

  it("plans d89-open-price-list from the focus-held price list", () => {
    expect(planAsIfSurfaced(gold("d89-open-price-list"))).toEqual({
      kind: "call",
      toolName: "pricing_getPriceList",
      input: { id: PRICE_LIST_ID },
      reply: "Ось прайс-лист.",
    });
  });

  it("plans d79-price-list-noun as the entries of that list", () => {
    expect(planAsIfSurfaced(gold("d79-price-list-noun"))).toEqual({
      kind: "call",
      toolName: "pricing_listPriceListEntries",
      input: { priceListId: PRICE_LIST_ID },
      reply: "Ось ціни прайс-листа.",
    });
  });

  it("narrows the price-list entries to a resolved product", () => {
    const said = gold("d79-price-list-noun");
    expect(
      planAsIfSurfaced({
        ...said,
        params: {
          ...said.params,
          product: resolved(PRODUCT_ID, "американо"),
        },
      }),
    ).toMatchObject({
      toolName: "pricing_listPriceListEntries",
      input: { priceListId: PRICE_LIST_ID, productId: PRODUCT_ID },
    });
  });

  it("plans the document list with no filter", () => {
    expect(
      planAsIfSurfaced({ text: "покажи документи", action: "documents.list" }),
    ).toEqual({
      kind: "call",
      toolName: "documents_list",
      input: {},
      reply: "Ось документи.",
    });
  });

  it("plans the layouts of a document type Shozee issues", () => {
    expect(
      planAsIfSurfaced({
        text: "покажи шаблони рахунків",
        action: "docGeneration.listLayouts",
        params: { document_type: { value: "payment_invoice" } },
      }),
    ).toEqual({
      kind: "call",
      toolName: "docGeneration_listLayouts",
      input: { type: "payment_invoice" },
      reply: "Ось шаблони документів.",
    });
  });

  it("refuses d78-unknown-price-list, which names no price list", () => {
    expect(planAsIfSurfaced(gold("d78-unknown-price-list"))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });

  it("never binds the catalogue's own demo id", () => {
    expect(
      planAsIfSurfaced(
        borrowed("d79-group-case", "customers.getGroup", ["group"], false),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses d73-base-document's act, which Shozee does not list", () => {
    expect(
      planAsIfSurfaced(
        borrowed("d73-base-document", "documents.list", ["document_type"]),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it.each([
    ["customers.getGroup", "group"],
    ["customers.getCounterparty", "counterparty"],
    ["pricing.getPriceList", "price_list"],
    ["pricing.listPriceListEntries", "price_list"],
    ["search.query", "search_text"],
    ["catalog.getProduct", "product"],
  ])("refuses %s without its required %s", (action) => {
    expect(planAsIfSurfaced({ text: "покажи", action })).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses customers.getCustomer naming neither customer, phone nor email", () => {
    expect(
      planAsIfSurfaced({
        text: "покажи клієнта",
        action: "customers.getCustomer",
      }),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("plans no documents.get: a spoken document number is never a uuid", () => {
    expect(SHO_READ_ACTIONS).not.toContain("documents.get");
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
    {
      text: "покажи контрагента фоп нечипорук галина",
      action: "customers.getCounterparty",
      params: {
        counterparty: {
          text: "фоп нечипорук галина",
          status: "resolved",
          id: "k-nechyporuk",
          name: "ФОП Нечипорук Галина",
          match: "exact",
        },
      },
      reason: "unsupported_param",
    },
    {
      text: "покажи контрагентів тов ранок",
      action: "customers.listCounterparties",
      params: { customer: { text: "тов ранок", status: "unchecked" } },
      reason: "unresolved_reference",
    },
    {
      text: "покажи непідписані документи",
      action: "documents.list",
      params: { signing_status: { value: "unsigned" } },
      reason: "unsupported_param",
    },
    {
      text: "покажи шаблони чеків",
      action: "docGeneration.listLayouts",
      params: { document_type: { value: "receipt" } },
      reason: "unsupported_param",
    },
    {
      text: "знайди доставку бариста лаб",
      action: "search.query",
      params: {
        search_text: { text: "бариста лаб" },
        search_type: { value: "shipment" },
      },
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
