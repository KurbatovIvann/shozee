export const SHO_CUSTOMER_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "d88-creates": {
      text: "створи клієнтку оксану осадчу",
      action: "customers.createCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        new_name: {
          text: "оксану осадчу",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
      creates: {
        type: "customer",
        name: "Оксана Осадча",
      },
    },
    "d93-staff": {
      text: "додай нову працівницю дарину мельник телефон 0671112233",
      action: "customers.createCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        new_name: {
          text: "дарину мельник",
        },
        phone: {
          text: "0671112233",
          value: "0671112233",
        },
      },
      needs: [
        {
          path: "action",
          reason: "unsupported",
          blocking: true,
          span: {
            text: "працівницю",
          },
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
    },
    "d94-create-kept": {
      text: "додай клієнта з номером 050 334 12 90",
      action: "customers.createCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        phone: {
          text: "050 334 12 90",
          value: "0503341290",
        },
      },
      needs: [
        {
          path: "new_name",
          reason: "missing",
          blocking: true,
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
    },
    "d94-named-kept": {
      text: "знайди клієнта тимур савчин з номером 050 334 12 90",
      action: "customers.createCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        new_name: {
          text: "тимур савчин",
        },
        phone: {
          text: "050 334 12 90",
          value: "0503341290",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
    },
    "d95-named-update": {
      text: "додай клієнту гончар коментар бере тільки оптом",
      action: "customers.updateCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "гончар",
          status: "resolved",
          id: "c-honchar",
          name: "Віталій Гончар",
          match: "form",
        },
        comment: {
          text: "бере тільки оптом",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d95-named-update-ru": {
      text: "добавь клиентке савчук комментарий забирает сама после обеда",
      action: "customers.updateCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "савчук",
          status: "resolved",
          id: "c-savchuk",
          name: "Олена Савчук",
          match: "form",
        },
        comment: {
          text: "забирает сама после обеда",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d95-named-unknown": {
      text: "додай клієнту марченко коментар платить карткою",
      action: "customers.updateCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "марченко",
          status: "unknown",
          suggest: {
            action: "customers.createCustomer",
            params: {
              new_name: {
                text: "марченко",
              },
              comment: {
                text: "платить карткою",
              },
            },
          },
        },
        comment: {
          text: "платить карткою",
        },
      },
      needs: [
        {
          path: "customer",
          reason: "unknown",
          blocking: true,
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d95-pointer-kept": {
      text: "додай цьому клієнту гончар коментар бере оптом",
      action: "customers.updateCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        comment: {
          text: "бере оптом",
        },
        customer: {
          text: "цьому клієнту",
          status: "context",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d95-noun-with-comment": {
      text: "додай клієнту коментар платить готівкою",
      action: "customers.updateCustomer",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        comment: {
          text: "платить готівкою",
        },
        customer: {
          text: "клієнту",
          status: "context",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
    "d79-group-update": {
      text: "признач групі салони партнерський прайс",
      action: "customers.updateGroup",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        group: {
          text: "салони",
          status: "resolved",
          id: "g-salons",
          name: "Салони",
          match: "exact",
        },
        price_list: {
          text: "партнерський",
          status: "resolved",
          id: "pl-partner",
          name: "Партнерський",
          match: "exact",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
    },
    "d89-rename-group": {
      text: "перейменуй її на квітникарі",
      action: "customers.updateGroup",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        rename_to: {
          text: "квітникарі",
        },
        group: {
          text: "її",
          status: "context",
          id: "new-florists",
          name: "Флористи",
          focus: 0,
        },
      },
      needs: [
        {
          path: "action",
          reason: "read_as_focus_type",
          blocking: false,
          span: {
            text: "її",
          },
        },
      ],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
  });

export function shoCustomerWriteParse(caseId: string): unknown {
  const parse = SHO_CUSTOMER_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}
