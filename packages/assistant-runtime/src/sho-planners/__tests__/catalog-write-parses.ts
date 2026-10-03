export const SHO_CATALOG_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "d78-unknown-priced": {
      text: "постав ціну на куртку шкіряну 1200 гривень",
      action: "catalog.updateProduct",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        product: {
          text: "куртку шкіряну",
          status: "unknown",
          suggest: {
            action: "catalog.createProduct",
            params: {
              new_name: {
                text: "куртку шкіряну",
              },
              price: {
                text: "1200 гривень",
                value: {
                  minor: 120000,
                  currency: "UAH",
                },
              },
            },
          },
        },
        price: {
          text: "1200 гривень",
          value: {
            minor: 120000,
            currency: "UAH",
          },
        },
      },
      needs: [
        {
          path: "product",
          reason: "unknown",
          blocking: true,
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "catalog",
      verb: "update",
    },
    "d89-archive-product": {
      text: "перенеси його в архів",
      action: "catalog.archiveProduct",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        product: {
          text: "його",
          status: "context",
          id: "new-balm",
          name: "Бальзам м'ятний",
          focus: 0,
        },
      },
      needs: [
        {
          path: "action",
          reason: "read_as_focus_type",
          blocking: false,
          span: {
            text: "його",
          },
        },
      ],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "remove",
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

export function shoCatalogWriteParse(caseId: string): unknown {
  const parse = SHO_CATALOG_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse for ${caseId}`);
  }
  return parse;
}
