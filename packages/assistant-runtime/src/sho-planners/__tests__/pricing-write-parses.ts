export const SHO_PRICING_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "d79-name-lead": {
      text: "створи прайс-лист для блогерів",
      action: "pricing.createPriceList",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        new_name: {
          text: "для блогерів",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "create",
    },
    "d88-unplaced": {
      text: "признач йому гуртовий прайс",
      action: "pricing.updatePriceList",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        price_list: {
          text: "гуртовий",
          status: "unknown",
          suggest: {
            action: "pricing.createPriceList",
            params: {
              new_name: {
                text: "гуртовий",
              },
            },
          },
        },
      },
      needs: [
        {
          path: "price_list",
          reason: "unknown",
          blocking: true,
        },
        {
          path: "action",
          reason: "reference",
          blocking: true,
          span: {
            text: "йому",
          },
        },
      ],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "update",
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
  });

export function shoPricingWriteParse(caseId: string): unknown {
  const parse = SHO_PRICING_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}
