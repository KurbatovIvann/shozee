export const SHO_ORDER_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "dv3-lines-01": {
      text: "замовлення для оксани сукня коктейльна червона 42 і тренч бежевий m",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "оксани",
          status: "unchecked",
        },
        items: [
          {
            product: {
              text: "сукня коктейльна",
              status: "unchecked",
            },
            attrs: [
              {
                text: "червона",
                variantIds: null,
              },
              {
                text: "42",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: null,
              said: [],
              value: 1,
              unit: null,
              unitText: null,
              implicit: true,
            },
          },
          {
            product: {
              text: "тренч",
              status: "unchecked",
            },
            attrs: [
              {
                text: "бежевий",
                variantIds: null,
              },
              {
                text: "m",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: null,
              said: [],
              value: 1,
              unit: null,
              unitText: null,
              implicit: true,
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "dv3-lines-16": {
      text: "замовлення для салону весна бальзам для губ полуничний 10 штук і сироватка з вітаміном c 30 мл 5 штук",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "салону весна",
          status: "unchecked",
        },
        items: [
          {
            product: {
              text: "бальзам для губ",
              status: "unchecked",
            },
            attrs: [
              {
                text: "полуничний",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "10 штук",
              said: ["10 штук"],
              value: 10,
              unit: "pcs",
              unitText: "штук",
            },
          },
          {
            product: {
              text: "сироватка з вітаміном c",
              status: "unchecked",
            },
            attrs: [
              {
                text: "30 мл",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "5 штук",
              said: ["5 штук"],
              value: 5,
              unit: "pcs",
              unitText: "штук",
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "dv3-lines-19": {
      text: "заказ олегу плитка 60 на 60 серая 15 квадратов и клей для плитки 5 мешков",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "олегу",
          status: "unchecked",
        },
        items: [
          {
            product: {
              text: "плитка",
              status: "unchecked",
            },
            attrs: [
              {
                text: "60 на 60",
                variantIds: null,
              },
              {
                text: "серая",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "15 квадратов",
              said: ["15 квадратов"],
              value: 15,
              unit: "m2",
              unitText: "квадратов",
            },
          },
          {
            product: {
              text: "клей для плитки",
              status: "unchecked",
            },
            attrs: [],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "5 мешков",
              said: ["5 мешков"],
              value: 5,
              unit: "bag",
              unitText: "мешков",
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "dv3-lines-20": {
      text: "фарба caparol біла 10 літрів дві банки для андрія",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "андрія",
          status: "unchecked",
        },
        items: [
          {
            product: {
              text: "фарба caparol",
              status: "unchecked",
            },
            attrs: [
              {
                text: "біла",
                variantIds: null,
              },
              {
                text: "10 літрів",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "дві банки",
              said: ["дві банки"],
              value: 2,
              unit: "can",
              unitText: "банки",
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "d73-surname-unknown": {
      text: "олені петренко три рулети макові",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "олені петренко",
          status: "resolved",
          id: "c-olena",
          name: "Олена",
          match: "form",
        },
        items: [
          {
            product: {
              text: "рулети макові",
              status: "resolved",
              id: "p-rolls",
              name: "Рулет маковий",
              match: "form",
            },
            attrs: [],
            variant: {
              status: "none",
            },
            quantity: {
              text: "три",
              said: ["три"],
              value: 3,
              unit: "pcs",
              unitText: null,
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: true,
      domain: "orders",
      verb: "create",
    },
    "d78-attrs-colour-size": {
      text: "замовлення для оксани мельник одну футболку базову білу m",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "оксани мельник",
          status: "resolved",
          id: "c-oksana",
          name: "Оксана Мельник",
          match: "form",
        },
        items: [
          {
            product: {
              text: "футболку базову",
              status: "resolved",
              id: "p-tee",
              name: "Футболка базова",
              match: "form",
            },
            attrs: [
              {
                text: "білу",
                variantIds: ["v-tee-1", "v-tee-2"],
              },
              {
                text: "m",
                variantIds: ["v-tee-1", "v-tee-3"],
              },
            ],
            variant: {
              status: "resolved",
              id: "v-tee-1",
              name: "Біла M",
              match: "attrs",
            },
            quantity: {
              text: "одну",
              said: ["одну"],
              value: 1,
              unit: null,
              unitText: null,
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: true,
      domain: "orders",
      verb: "create",
    },
    "d75-kilo": {
      text: "олегу сир гауда 0,5",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "олегу",
          status: "resolved",
          id: "c-oleh",
          name: "Олег Бондар",
          match: "form",
        },
        items: [
          {
            product: {
              text: "сир гауда",
              status: "resolved",
              id: "p-cheese",
              name: "Сир гауда",
              match: "exact",
            },
            attrs: [],
            variant: {
              status: "none",
            },
            quantity: {
              text: "0,5",
              said: ["0,5"],
              value: 0.5,
              unit: "kg",
              unitText: null,
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: true,
      domain: "orders",
      verb: "create",
    },
    "dv3-orders-25": {
      text: "замовлення для тетяни на понеділок три букети півоній оплата готівкою",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "тетяни",
          status: "unchecked",
        },
        items: [
          {
            product: {
              text: "букети півоній",
              status: "unchecked",
            },
            attrs: [],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "три",
              said: ["три"],
              value: 3,
              unit: null,
              unitText: null,
            },
          },
        ],
        due: {
          text: "на понеділок",
          value: {
            date: "2026-09-28",
            time: null,
            bound: "at",
          },
        },
        payment_method: {
          value: "cash",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "d94-order-phone-dative": {
      text: "створи замовлення клієнту з телефоном 0935550122 одну олію для кутикули 1 л",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "0935550122",
          status: "resolved",
          by: "phone",
          value: "0935550122",
          id: "c-ostap",
          name: "Остап Гнатюк",
          match: "phone",
        },
        items: [
          {
            product: {
              text: "олію для кутикули",
              status: "unchecked",
            },
            attrs: [
              {
                text: "1 л",
                variantIds: null,
              },
            ],
            variant: {
              status: "unchecked",
            },
            quantity: {
              text: "одну",
              said: ["одну"],
              value: 1,
              unit: null,
              unitText: null,
            },
          },
        ],
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "create",
    },
    "d95-noun-alone-confirm": {
      text: "підтверди клієнту",
      action: "orders.confirm",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {},
      needs: [
        {
          path: "order_number|customer|period|amount",
          reason: "missing",
          blocking: true,
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "status",
    },
    "d88-object-order": {
      text: "підтверди його",
      action: "orders.confirm",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        order_number: {
          text: "його",
          status: "context",
          id: "o-7001",
          name: "№ 7001",
          focus: 0,
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "status",
    },
    "d89-delete-customer": {
      text: "а тепер видали її будь ласка",
      action: "customers.deleteCustomer",
      kind: "high",
      effect: "destructive",
      confirm: "strong",
      params: {
        customer: {
          text: "її",
          status: "context",
          id: "new-marta",
          name: "Марта Ковальчук",
          focus: 0,
        },
      },
      needs: [
        {
          path: "action",
          reason: "read_as_focus_type",
          blocking: false,
          span: { text: "її" },
        },
      ],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "cancel",
    },
    "d90-closed-order": {
      text: "підтверджуй його зараз же",
      action: "orders.confirm",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {},
      needs: [
        {
          path: "order_number",
          reason: "reference",
          blocking: true,
          span: {
            text: "його",
          },
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "orders",
      verb: "status",
    },
  });

export function shoOrderWriteParse(caseId: string): unknown {
  const parse = SHO_ORDER_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}
