export const SHO_DOCUMENT_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "d73-base-document": {
      text: "зроби акт на рахунок 57",
      action: "documents.createFromOrder",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        document_type: {
          value: "act",
        },
        basis: {
          text: "57",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "documents",
      verb: "create",
    },
    "d92-ordinal-no-sum": {
      text: "виставити рахунок на 21-ше число для олени савчук",
      action: "documents.createFromOrder",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        customer: {
          text: "олени савчук",
          status: "resolved",
          id: "c-savchuk",
          name: "Олена Савчук",
          match: "form",
        },
      },
      needs: [
        {
          path: "text",
          reason: "ignored",
          blocking: false,
          span: {
            text: "21-ше",
          },
        },
      ],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "documents",
      verb: "create",
    },
    "coffee_tea-01-026": {
      text: "і виставити рахунок",
      action: "documents.createFromOrder",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        document_type: {
          value: "payment_invoice",
        },
        order_number: {
          text: "",
          status: "previous",
          command: 0,
        },
      },
      needs: [],
      ready: true,
      refPrevious: {
        order_number: 0,
      },
      catalogued: false,
      domain: "documents",
      verb: "create",
    },
    "flowers-01-029": {
      text: "і скинь їм рахунок у вайбер",
      action: "documents.share",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        document_type: {
          value: "payment_invoice",
        },
        channel: {
          value: "viber",
        },
        customer: {
          text: "максиму кравцу",
          status: "resolved",
          id: "c-09",
          name: "Максим Кравець",
          match: "form",
        },
        order_number: {
          text: "",
          status: "previous",
          command: 0,
        },
      },
      needs: [],
      ready: true,
      refPrevious: {
        customer: 0,
        order_number: 0,
      },
      catalogued: false,
      domain: "documents",
      verb: "send",
    },
    "tools-01-085": {
      text: "и выстави счет",
      action: "documents.createFromOrder",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        document_type: {
          value: "payment_invoice",
        },
        order_number: {
          text: "",
          status: "previous",
          command: 0,
        },
      },
      needs: [],
      ready: true,
      refPrevious: {
        order_number: 0,
      },
      catalogued: false,
      domain: "documents",
      verb: "create",
    },
  });

export function shoDocumentWriteParse(caseId: string): unknown {
  const parse = SHO_DOCUMENT_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}
