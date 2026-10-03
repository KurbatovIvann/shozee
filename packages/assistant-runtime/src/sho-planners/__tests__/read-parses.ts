export const SHO_READ_PARSES: Readonly<Record<string, unknown>> = Object.freeze(
  {
    "d72-read-groups": {
      text: "покажи групи",
      action: "customers.listGroups",
      kind: "read",
      effect: "read",
      confirm: "none",
      params: {},
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "list",
    },
    "d78-unknown-price-list": {
      text: "покажи прайс гуртовий",
      action: "pricing.getPriceList",
      kind: "read",
      effect: "read",
      confirm: "none",
      params: {
        price_list: {
          text: "гуртовий",
          status: "unknown",
          suggest: {
            action: "pricing.createPriceList",
            params: { new_name: { text: "гуртовий" } },
          },
        },
      },
      needs: [{ path: "price_list", reason: "unknown", blocking: true }],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "get",
    },
    "d89-open-price-list": {
      text: "відкрий його ще раз",
      action: "pricing.getPriceList",
      kind: "read",
      effect: "read",
      confirm: "none",
      params: {
        price_list: {
          text: "його",
          status: "context",
          id: "new-autumn",
          name: "Осінній",
          focus: 0,
        },
      },
      needs: [
        {
          path: "action",
          reason: "read_as_focus_type",
          blocking: false,
          span: { text: "його" },
        },
      ],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "get",
    },
    "d79-price-list-noun": {
      text: "що в нас у партнерському прайсі",
      action: "pricing.listPriceListEntries",
      kind: "read",
      effect: "read",
      confirm: "none",
      params: {
        price_list: {
          text: "партнерському",
          status: "resolved",
          id: "pl-partner",
          name: "Партнерський",
          match: "form",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "list",
    },
    "d79-group-case": {
      text: "переведи ігоря литвина і тараса гречка в групу установи",
      action: "customers.setGroup",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customers: [
          {
            text: "ігоря литвина",
            status: "resolved",
            id: "c-lytvyn",
            name: "Ігор Литвин",
            match: "form",
          },
          {
            text: "тараса гречка",
            status: "resolved",
            id: "c-hrechko",
            name: "Тарас Гречко",
            match: "form",
          },
        ],
        group: {
          text: "установи",
          status: "resolved",
          id: "g-institutions",
          name: "Установи",
          match: "exact",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d79-counterparty-rest": {
      text: "зміни телефон контрагента фоп нечипорук галина на 0501112233",
      action: "customers.updateCounterparty",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        counterparty: {
          text: "фоп нечипорук галина",
          status: "resolved",
          id: "k-nechyporuk",
          name: "ФОП Нечипорук Галина",
          match: "exact",
        },
        phone: { text: "0501112233", value: "0501112233" },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d72-stock-list": {
      text: "які болгарки є в наявності",
      action: "stock.list",
      kind: "read",
      effect: "read",
      confirm: "none",
      params: { search_text: { text: "болгарки" } },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "stock",
      verb: "list",
    },
    "d73-base-document": {
      text: "зроби акт на рахунок 57",
      action: "documents.createFromOrder",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        document_type: { value: "act" },
        basis: { text: "57" },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "documents",
      verb: "create",
    },
  },
);

export function shoReadParse(caseId: string): unknown {
  const parse = SHO_READ_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}

export function shoReadParams(caseId: string): Record<string, unknown> {
  const parse = shoReadParse(caseId) as { params?: Record<string, unknown> };
  return parse.params ?? {};
}
