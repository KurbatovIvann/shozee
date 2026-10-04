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
    "d79-fraction-words": {
      text: "в оптовий прайс червоний лак есі тринадцять і п'ять мілілітрів за триста сорок",
      action: "pricing.setPriceListEntries",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        price_list: {
          text: "оптовий",
          status: "resolved",
          id: "pl-wholesale",
          name: "Опт",
          match: "form",
        },
        product: {
          text: "лак есі",
          status: "resolved",
          id: "p-essie",
          name: "Лак для нігтів Essie",
          match: "alias",
        },
        variant: {
          text: "червоний тринадцять п'ять мілілітрів",
          status: "resolved",
          id: "v-essie-red-135",
          name: "Червоний 13,5 мл",
          match: "attrs",
          attrs: [
            {
              text: "червоний",
              variantIds: ["v-essie-red-5", "v-essie-red-135"],
            },
            {
              text: "тринадцять і п'ять мілілітрів",
              variantIds: ["v-essie-red-135", "v-essie-nude-135"],
            },
          ],
        },
        price: {
          text: "триста сорок",
          value: { minor: 34000, currency: "UAH" },
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "set",
    },
    "d79-price-list-case": {
      text: "поло kappa темно-синє xl з опту прибери",
      action: "pricing.removePriceListEntries",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        product: {
          text: "поло kappa",
          status: "resolved",
          id: "p-polo",
          name: "Поло чоловіче Kappa",
          match: "alias",
        },
        variant: {
          text: "темно-синє xl",
          status: "resolved",
          id: "v-polo-navy-xl",
          name: "Темно-синє XL",
          match: "attrs",
          attrs: [
            {
              text: "темно-синє",
              variantIds: ["v-polo-navy-l", "v-polo-navy-xl"],
            },
            { text: "xl", variantIds: ["v-polo-navy-xl"] },
          ],
        },
        price_list: {
          text: "опту",
          status: "resolved",
          id: "pl-wholesale",
          name: "Опт",
          match: "form",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "pricing",
      verb: "remove",
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
