export const SHO_COMPANY_WRITE_PARSES: Readonly<Record<string, unknown>> =
  Object.freeze({
    "d70-edrpou-length": {
      text: "зміни реквізити єдрпоу 1436057",
      action: "companies.updateLegal",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        edrpou: { text: "1436057", value: "1436057" },
      },
      needs: [{ path: "edrpou", reason: "invalid_value", blocking: true }],
      ready: false,
      refPrevious: {},
      catalogued: false,
      domain: "company",
      verb: "update",
    },
    "d70-iban-ok": {
      text: "додай контрагента молокія айбан ua21 3223 1300 0002 6007 2335 6600 1",
      action: "customers.createCounterparty",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        new_name: { text: "молокія" },
        iban: {
          text: "ua21 3223 1300 0002 6007 2335 6600 1",
          value: "UA213223130000026007233566001",
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "create",
    },
    "d79-counterparty-legal": {
      text: "онови адресу тов сота спейс вулиця бджолина 8",
      action: "customers.updateCounterparty",
      kind: "write",
      effect: "write",
      confirm: "card",
      params: {
        counterparty: {
          text: "тов сота спейс",
          status: "resolved",
          id: "k-sota",
          name: "ТОВ «Сота Спейс»",
          match: "exact",
        },
        address: {
          text: "вулиця бджолина 8",
          value: { street: "бджолина", house: "8", apt: null },
        },
      },
      needs: [],
      ready: true,
      refPrevious: {},
      catalogued: false,
      domain: "customers",
      verb: "update",
    },
  });

export function shoCompanyWriteParse(caseId: string): unknown {
  const parse = SHO_COMPANY_WRITE_PARSES[caseId];
  if (parse === undefined) {
    throw new Error(`no conformance parse ${caseId}`);
  }
  return parse;
}
