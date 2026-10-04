import { toProviderToolName } from "@showzy/ai";
import { isConfirmableRisk } from "@showzy/core/contract";
import {
  archiveCustomerContract,
  createCounterpartyContract,
  createCustomerContract,
  createGroupContract,
  deleteCounterpartyContract,
  deleteCustomerContract,
  deleteGroupContract,
  restoreCustomerContract,
  updateCounterpartyContract,
  updateCustomerContract,
  updateGroupContract,
} from "@showzy/customers/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import {
  cloneShoParse,
  shoCustomerWriteParse,
} from "./__tests__/customer-write-parses.js";
import { shoOrderWriteParse } from "./__tests__/order-write-parses.js";
import { shoReadParse } from "./__tests__/read-parses.js";
import {
  SHO_CUSTOMER_WRITE_ACTIONS,
  SHO_CUSTOMER_WRITE_PLANNERS,
  SHO_CUSTOMER_WRITE_PLANNER_PARAMS,
  SHO_READ_AS_CUSTOMER_UPDATE_NOTE,
  SHO_READ_AS_FOCUS_COUNTERPARTY_NOTE,
  SHO_READ_AS_FOCUS_CUSTOMER_NOTE,
  SHO_READ_AS_FOCUS_GROUP_NOTE,
  SHO_READ_AS_UPDATE_NOTE,
} from "./customers-writes.js";
import { SHO_WRITE_ACTIONS } from "./orders-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const COMPANY_IDS: Readonly<Record<string, string>> = {
  "c-honchar": "6d2f0a71-4c83-4e19-9a7b-2f58d31c6e40",
  "c-savchuk": "b18c7e52-30d9-4a66-8f21-5c90e4a7b3d6",
  "g-salons": "2a47f5c8-91b0-4d3e-8c62-7e01b9d45f38",
  "c-lytvyn": "7f3b1d64-28ea-4c05-9b17-6d84a2f0c591",
  "c-hrechko": "51ac9e37-6b42-4f80-8d23-0e795b1c4a68",
  "g-regular": "cf062b19-74d5-4a38-9e61-83b027d5fa14",
  "g-institutions": "4e5d8b02-1c93-4786-a0f5-29b641e73c8d",
  "new-wedding": "9b7e4a15-03cf-42d6-8714-5ad62c90e38b",
  "new-florists": "a3184c76-5e2b-49f0-b86d-71c40f9325ae",
  "new-zlata": "0d26f948-8a71-4b53-91ce-3f807264ad15",
  "new-marta": "6c91a78d-42e0-4f15-bd37-08e5349b716f",
  "pl-partner": "d7420f63-95b8-41ca-8e07-16b3d8205c49",
  "k-nechyporuk": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "k-sota": "8e2c71b4-0d9a-4f36-95e8-6c1374ab02fd",
  "k-kovalenko-p": "1b5f90d3-7a46-48c2-80be-f2951d6e4c07",
  "k-farm": "e4719c20-3b85-4d61-a9f7-50c8b63142de",
};

type Json = Record<string, unknown>;

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

const parseOf = (caseId: string): Json =>
  cloneShoParse(shoCustomerWriteParse(caseId));

const paramsOf = (caseId: string): Json => parseOf(caseId)["params"] as Json;

function commandOf(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parseOf(caseId),
    ...patch,
  });
}

function asCompanyRecords(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...(reId(parseOf(caseId)) as Json),
    ...patch,
  });
}

function resultOf(command: ShoCommand): ShoResult {
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: command.text,
    segments: [command.text],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 1, revision: null },
  });
}

const TOOL_INPUTS: Readonly<Record<string, (input: unknown) => boolean>> = {
  [toProviderToolName(createCustomerContract.name)]: (input) =>
    createCustomerContract.input.safeParse(input).success,
  [toProviderToolName(updateCustomerContract.name)]: (input) =>
    updateCustomerContract.input.safeParse(input).success,
  [toProviderToolName(archiveCustomerContract.name)]: (input) =>
    archiveCustomerContract.input.safeParse(input).success,
  [toProviderToolName(restoreCustomerContract.name)]: (input) =>
    restoreCustomerContract.input.safeParse(input).success,
  [toProviderToolName(deleteCustomerContract.name)]: (input) =>
    deleteCustomerContract.input.safeParse(input).success,
  [toProviderToolName(createGroupContract.name)]: (input) =>
    createGroupContract.input.safeParse(input).success,
  [toProviderToolName(updateGroupContract.name)]: (input) =>
    updateGroupContract.input.safeParse(input).success,
  [toProviderToolName(deleteGroupContract.name)]: (input) =>
    deleteGroupContract.input.safeParse(input).success,
  [toProviderToolName(createCounterpartyContract.name)]: (input) =>
    createCounterpartyContract.input.safeParse(input).success,
  [toProviderToolName(updateCounterpartyContract.name)]: (input) =>
    updateCounterpartyContract.input.safeParse(input).success,
  [toProviderToolName(deleteCounterpartyContract.name)]: (input) =>
    deleteCounterpartyContract.input.safeParse(input).success,
};

function toolAccepts(toolName: string, input: unknown): boolean {
  const accepts = TOOL_INPUTS[toolName];
  if (accepts === undefined) {
    throw new Error(`no action input schema for ${toolName}`);
  }
  return accepts(input);
}

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_CUSTOMER_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no customer write planner for ${command.action}`);
  }
  const plan = planner.plan(command, NOW);
  if (plan.kind === "call") {
    expect({
      action: command.action,
      accepted: toolAccepts(plan.toolName, plan.input),
    }).toEqual({ action: command.action, accepted: true });
  }
  return plan;
}

const notesOf = (plan: ShoActionPlan): unknown =>
  plan.kind === "call" ? plan.notes : "not a call";

const whitelisted = createShoPlanner({
  actions: [
    ...SHO_READ_ACTIONS,
    ...SHO_WRITE_ACTIONS,
    ...SHO_CUSTOMER_WRITE_ACTIONS,
  ],
});

describe("SHO_CUSTOMER_WRITE_PLANNERS maps the conformance create parses", () => {
  it("plans d94-named-kept on the name said and the normalised phone", () => {
    expect(planOf(commandOf("d94-named-kept"))).toEqual({
      kind: "call",
      toolName: "customers_createCustomer",
      reply: "Клієнта створено.",
      input: { name: "тимур савчин", phone: "0503341290" },
    });
  });

  it("names the d88-creates customer in the nominative the runtime read", () => {
    const named = paramsOf("d94-named-kept");
    const plan = planOf(
      commandOf("d88-creates", {
        params: { ...paramsOf("d88-creates"), phone: named["phone"] },
      }),
    );
    expect(plan).toEqual({
      kind: "call",
      toolName: "customers_createCustomer",
      reply: "Клієнта створено.",
      input: { name: "Оксана Осадча", phone: "0503341290" },
    });
  });

  it("sends d88-creates to the LLM while the parse names no contact", () => {
    expect(planOf(commandOf("d88-creates"))).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("sends d94-create-kept to the LLM: the create has no name to store", () => {
    expect(whitelisted(resultOf(commandOf("d94-create-kept")), NOW)).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("sends d93-staff to the LLM: a staff member is no customer", () => {
    expect(whitelisted(resultOf(commandOf("d93-staff")), NOW)).toEqual({
      kind: "fallback",
      reason: "unsupported_action",
    });
  });
});

const RENAME_TO = paramsOf("d89-rename-group")["rename_to"];

const renaming = (caseId: string, fields: Json = {}): ShoCommand =>
  asCompanyRecords(caseId, {
    params: {
      customer: (reId(paramsOf(caseId)) as Json)["customer"],
      rename_to: RENAME_TO,
      ...fields,
    },
  });

describe("SHO_CUSTOMER_WRITE_PLANNERS maps the conformance update parses", () => {
  it("plans a renaming d95-named-update as that customer's update", () => {
    expect(planOf(renaming("d95-named-update"))).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: { id: COMPANY_IDS["c-honchar"], name: "квітникарі" },
    });
  });

  it("plans the Russian d95-named-update-ru the same way", () => {
    expect(
      planOf(
        renaming("d95-named-update-ru", {
          comment: paramsOf("d95-named-update-ru")["comment"],
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-savchuk"],
        name: "квітникарі",
        notes: "забирает сама после обеда",
      },
    });
  });

  it("plans the D84 notes-only d95-named-update with no name at all", () => {
    expect(planOf(asCompanyRecords("d95-named-update"))).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-honchar"],
        notes: "бере тільки оптом",
      },
    });
  });

  it("plans the Russian notes-only d95-named-update-ru with no name either", () => {
    expect(planOf(asCompanyRecords("d95-named-update-ru"))).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-savchuk"],
        notes: "забирает сама после обеда",
      },
    });
  });

  it("asks rather than plan an empty card when the parse names only the customer", () => {
    expect(
      planOf(
        asCompanyRecords("d95-named-update", {
          params: { customer: reId(paramsOf("d95-named-update")["customer"]) },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("plans the d79-group-update group as the customer's groupId", () => {
    const plan = planOf(
      renaming("d95-named-update", {
        group: reId(paramsOf("d79-group-update")["group"]),
      }),
    );
    expect(plan).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-honchar"],
        name: "квітникарі",
        groupId: COMPANY_IDS["g-salons"],
      },
    });
  });

  it("sends a price_list to the LLM: the planner maps no price list", () => {
    expect(
      planOf(
        renaming("d95-named-update", {
          price_list: reId(paramsOf("d79-group-update")["price_list"]),
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("sends only what Шо parsed, so an unsaid field keeps its stored value", () => {
    const plan = planOf(
      renaming("d95-named-update", {
        comment: paramsOf("d95-named-update")["comment"],
      }),
    );
    expect(Object.keys(plan.kind === "call" ? plan.input : {}).sort()).toEqual([
      "id",
      "name",
      "notes",
    ]);
  });
});

const renamingAsSaid = (caseId: string): ShoCommand =>
  commandOf(caseId, {
    params: {
      customer: paramsOf(caseId)["customer"],
      rename_to: RENAME_TO,
    },
  });

describe("a customer write names only the record the parse resolved", () => {
  it("refuses the catalogue's own record id, which is no uuid", () => {
    expect(planOf(renamingAsSaid("d95-named-update"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses d95-named-unknown, whose customer the list does not know", () => {
    expect(planOf(renamingAsSaid("d95-named-unknown"))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });

  it("writes to no record the bare pointer stands for", () => {
    for (const caseId of ["d95-pointer-kept", "d95-noun-with-comment"]) {
      expect({ caseId, plan: planOf(renamingAsSaid(caseId)) }).toEqual({
        caseId,
        plan: { kind: "fallback", reason: "conversation_dependent" },
      });
    }
  });
});

describe("a Шо customer write only ever reaches the preview", () => {
  it("declares writes on every customer write planner", () => {
    for (const action of SHO_CUSTOMER_WRITE_ACTIONS) {
      expect({
        action,
        writes: SHO_CUSTOMER_WRITE_PLANNERS[action]?.writes,
      }).toEqual({ action, writes: true });
    }
  });

  it("names the planned params of every planned action", () => {
    expect(Object.keys(SHO_CUSTOMER_WRITE_PLANNER_PARAMS)).toEqual([
      ...SHO_CUSTOMER_WRITE_ACTIONS,
    ]);
  });

  it("refuses a customer write parse that arrives with a read's effect", () => {
    expect(
      whitelisted(
        resultOf(
          asCompanyRecords("d95-named-update", {
            kind: "read",
            effect: "read",
            confirm: "none",
          }),
        ),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans nothing for a customer write no deployment whitelisted", () => {
    expect(
      createShoPlanner({
        actions: [...SHO_READ_ACTIONS, ...SHO_WRITE_ACTIONS],
      })(resultOf(asCompanyRecords("d95-named-update")), NOW),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});

describe("the D84 and D85 misreads are carried to the card", () => {
  const withNeed = (
    reason: string,
    blocking: boolean,
    span: string | null,
  ): ShoCommand =>
    asCompanyRecords("d95-named-update", {
      params: {
        customer: (reId(paramsOf("d95-named-update")) as Json)["customer"],
        rename_to: RENAME_TO,
      },
      needs: [
        {
          path: "action",
          reason,
          blocking,
          ...(span === null ? {} : { span: { text: span } }),
        },
      ],
    });

  it("notes the D84 span the create-read-as-update hangs on", () => {
    expect(
      notesOf(planOf(withNeed("read_as_update", false, "гончар"))),
    ).toEqual([`${SHO_READ_AS_UPDATE_NOTE}: «гончар».`]);
  });

  it("notes the D85 group edit read as the customer's own update", () => {
    expect(
      notesOf(planOf(withNeed("read_as_customer_update", false, "петя жолоб"))),
    ).toEqual([`${SHO_READ_AS_CUSTOMER_UPDATE_NOTE}: «петя жолоб».`]);
  });

  it("notes the misread even with no span to quote", () => {
    expect(notesOf(planOf(withNeed("read_as_update", false, null)))).toEqual([
      `${SHO_READ_AS_UPDATE_NOTE}.`,
    ]);
  });

  it("carries no note when the parse reports no misread", () => {
    expect(notesOf(planOf(renaming("d95-named-update")))).toBeUndefined();
  });

  it("carries no note for a need the parse marked blocking", () => {
    expect(
      notesOf(planOf(withNeed("read_as_update", true, "гончар"))),
    ).toBeUndefined();
  });
});

const verbatim = (parse: unknown): ShoCommand =>
  shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...(reId(cloneShoParse(parse)) as Json),
  });

const archiving = (): ShoCommand =>
  asCompanyRecords("d90-closed-restore", {
    action: "customers.archiveCustomer",
    verb: "remove",
    params: { customer: reId(paramsOf("d90-closed-restore")["customer"]) },
  });

describe("SHO_CUSTOMER_WRITE_PLANNERS maps the conformance lifecycle parses", () => {
  it("plans d90-closed-restore as that customer's restore", () => {
    expect(planOf(asCompanyRecords("d90-closed-restore"))).toEqual({
      kind: "call",
      toolName: "customers_restoreCustomer",
      reply: "Клієнта повернуто з архіву.",
      input: { id: COMPANY_IDS["c-savchuk"] },
    });
  });

  it("archives d90-closed-restore's customer: no gold archive parse resolves one", () => {
    expect(planOf(archiving())).toEqual({
      kind: "call",
      toolName: "customers_archiveCustomer",
      reply: "Клієнта заархівовано.",
      input: { id: COMPANY_IDS["c-savchuk"] },
    });
  });

  it("sends the gold d89-no-archive-asks archive to the LLM: it names no record", () => {
    expect(
      whitelisted(resultOf(asCompanyRecords("d89-no-archive-asks")), NOW),
    ).toEqual({ kind: "fallback", reason: "needs_reference" });
  });

  it("plans d89-delete-customer as that delete, with the misread noted", () => {
    expect(planOf(verbatim(shoOrderWriteParse("d89-delete-customer")))).toEqual(
      {
        kind: "call",
        toolName: "customers_deleteCustomer",
        reply: "Клієнта видалено.",
        input: { id: COMPANY_IDS["new-marta"] },
        notes: [`${SHO_READ_AS_FOCUS_CUSTOMER_NOTE}: «її».`],
      },
    );
  });

  it("sends d90-type-verb-offer to the LLM while the reference is unchecked", () => {
    expect(
      whitelisted(resultOf(asCompanyRecords("d90-type-verb-offer")), NOW),
    ).toEqual({ kind: "fallback", reason: "needs_reference" });
  });

  it("maps no param beyond the record for a lifecycle write", () => {
    expect(
      planOf(
        asCompanyRecords("d90-closed-restore", {
          params: {
            customer: reId(paramsOf("d90-closed-restore")["customer"]),
            comment: paramsOf("d95-named-update")["comment"],
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("SHO_CUSTOMER_WRITE_PLANNERS maps the conformance group parses", () => {
  it("plans d93-customer-group-kept as the group create", () => {
    expect(planOf(commandOf("d93-customer-group-kept"))).toEqual({
      kind: "call",
      toolName: "customers_createGroup",
      reply: "Групу створено.",
      input: { name: "гуртівня" },
    });
  });

  it("plans the d79-group-update price list onto a created group", () => {
    expect(
      planOf(
        asCompanyRecords("d93-customer-group-kept", {
          params: {
            new_name: paramsOf("d93-customer-group-kept")["new_name"],
            price_list: reId(paramsOf("d79-group-update")["price_list"]),
          },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_createGroup",
      reply: "Групу створено.",
      input: { name: "гуртівня", priceListId: COMPANY_IDS["pl-partner"] },
    });
  });

  it("sends d93-product-group to the LLM: a group of goods is no customer group", () => {
    expect(whitelisted(resultOf(commandOf("d93-product-group")), NOW)).toEqual({
      kind: "fallback",
      reason: "unsupported_action",
    });
  });

  it("plans d89-rename-group as that group's rename, with the misread noted", () => {
    expect(planOf(asCompanyRecords("d89-rename-group"))).toEqual({
      kind: "call",
      toolName: "customers_updateGroup",
      reply: "Групу оновлено.",
      input: { id: COMPANY_IDS["new-florists"], name: "квітникарі" },
      notes: [`${SHO_READ_AS_FOCUS_GROUP_NOTE}: «її».`],
    });
  });

  it("plans d79-group-update as the group's price list and nothing else", () => {
    expect(planOf(asCompanyRecords("d79-group-update"))).toEqual({
      kind: "call",
      toolName: "customers_updateGroup",
      reply: "Групу оновлено.",
      input: {
        id: COMPANY_IDS["g-salons"],
        priceListId: COMPANY_IDS["pl-partner"],
      },
    });
  });

  it("asks rather than plan an empty card when the parse names only the group", () => {
    expect(
      planOf(
        asCompanyRecords("d79-group-update", {
          params: { group: reId(paramsOf("d79-group-update")["group"]) },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("plans d88-this-group-screen as that group's delete", () => {
    expect(planOf(asCompanyRecords("d88-this-group-screen"))).toEqual({
      kind: "call",
      toolName: "customers_deleteGroup",
      reply: "Групу видалено.",
      input: { id: COMPANY_IDS["new-wedding"] },
    });
  });
});

describe("customers.setGroup plans one customers.updateCustomer", () => {
  it("plans d88-there-group as {id, groupId} on the focused group", () => {
    expect(planOf(asCompanyRecords("d88-there-group"))).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-lytvyn"],
        groupId: COMPANY_IDS["new-wedding"],
      },
    });
  });

  it("plans d89-screen-when-chat-silent onto the group on screen", () => {
    expect(planOf(asCompanyRecords("d89-screen-when-chat-silent"))).toEqual({
      kind: "call",
      toolName: "customers_updateCustomer",
      reply: "Клієнта оновлено.",
      input: {
        id: COMPANY_IDS["c-lytvyn"],
        groupId: COMPANY_IDS["g-regular"],
      },
    });
  });

  it("notes the focus misread on d88-there-group's «туди», as d89-rename-group's need reads it", () => {
    expect(
      notesOf(
        planOf(
          asCompanyRecords("d88-there-group", {
            needs: parseOf("d89-rename-group")["needs"],
          }),
        ),
      ),
    ).toEqual([`${SHO_READ_AS_FOCUS_GROUP_NOTE}: «її».`]);
  });

  it("sends the d79-group-case batch to the LLM: one card is not one write", () => {
    expect(planOf(verbatim(shoReadParse("d79-group-case")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("asks when the parse names customers and no group", () => {
    expect(
      planOf(
        asCompanyRecords("d88-there-group", {
          params: { customers: reId(paramsOf("d88-there-group")["customers"]) },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("guesses no group from d78-unknown-group's text the list does not know", () => {
    expect(
      planOf(
        asCompanyRecords("d88-there-group", {
          params: {
            customers: reId(paramsOf("d88-there-group")["customers"]),
            group: paramsOf("d78-unknown-group")["group"],
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });
});

describe("a lifecycle or group write binds no record the parse did not resolve", () => {
  const AS_SAID: readonly string[] = [
    "d90-closed-restore",
    "d90-type-verb-offer",
    "d88-this-group-screen",
    "d89-rename-group",
    "d88-there-group",
  ];

  it("refuses the catalogue's own record ids, which are no uuids", () => {
    for (const caseId of AS_SAID) {
      expect({ caseId, plan: planOf(commandOf(caseId)) }).toEqual({
        caseId,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });
});

describe("SHO_CUSTOMER_WRITE_PLANNERS maps the conformance counterparty parses", () => {
  it("plans d70-edrpou-ok as the create with the typed ЄДРПОУ", () => {
    expect(planOf(commandOf("d70-edrpou-ok"))).toEqual({
      kind: "call",
      toolName: "customers_createCounterparty",
      reply: "Контрагента створено.",
      input: { name: "приватбанк", edrpou: "14360570" },
    });
  });

  it("plans d70-iban-ok on the normalised IBAN, not the spoken span", () => {
    expect(planOf(commandOf("d70-iban-ok"))).toEqual({
      kind: "call",
      toolName: "customers_createCounterparty",
      reply: "Контрагента створено.",
      input: { name: "молокія", iban: "UA213223130000026007233566001" },
    });
  });

  it("plans d79-counterparty-rest as that counterparty's update", () => {
    expect(planOf(asCompanyRecords("d79-counterparty-rest"))).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-nechyporuk"], phone: "0501112233" },
    });
  });

  it("plans the d79-counterparty-legal address as the legal address said", () => {
    expect(planOf(asCompanyRecords("d79-counterparty-legal"))).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-sota"], legalAddress: "вулиця бджолина 8" },
    });
  });

  it("plans the d93-counterparty-kept bank as the name the staff said", () => {
    expect(planOf(asCompanyRecords("d93-counterparty-kept"))).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-nechyporuk"], bankName: "монобанк" },
    });
  });

  it("plans d79-counterparty-patronymic as that counterparty's delete", () => {
    expect(planOf(asCompanyRecords("d79-counterparty-patronymic"))).toEqual({
      kind: "call",
      toolName: "customers_deleteCounterparty",
      reply: "Контрагента видалено.",
      input: { id: COMPANY_IDS["k-kovalenko-p"] },
    });
  });

  it("plans the d88-this-counterparty the conversation holds in focus", () => {
    expect(planOf(asCompanyRecords("d88-this-counterparty"))).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-farm"], phone: "0442223344" },
    });
  });

  it("notes the d89-edit-counterparty misread on the card", () => {
    expect(planOf(asCompanyRecords("d89-edit-counterparty"))).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-farm"], email: "zbut@ferma.ua" },
      notes: [`${SHO_READ_AS_FOCUS_COUNTERPARTY_NOTE}: «йому».`],
    });
  });

  it("notes the d89-delete-counterparty misread on the card", () => {
    expect(planOf(asCompanyRecords("d89-delete-counterparty"))).toEqual({
      kind: "call",
      toolName: "customers_deleteCounterparty",
      reply: "Контрагента видалено.",
      input: { id: COMPANY_IDS["k-farm"] },
      notes: [`${SHO_READ_AS_FOCUS_COUNTERPARTY_NOTE}: «его».`],
    });
  });

  it("asks rather than plan an empty card when only the counterparty is said", () => {
    expect(
      planOf(
        asCompanyRecords("d79-counterparty-rest", {
          params: {
            counterparty: reId(
              paramsOf("d79-counterparty-rest")["counterparty"],
            ),
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("sends d93-own-requisites to the LLM: the shop is no counterparty", () => {
    expect(
      whitelisted(resultOf(asCompanyRecords("d93-own-requisites")), NOW),
    ).toEqual({ kind: "fallback", reason: "unsupported_action" });
  });
});

describe("a counterparty write takes an identifier only as Шо typed it", () => {
  const withRequisite = (field: string, param: Json): ShoCommand =>
    asCompanyRecords("d79-counterparty-rest", {
      params: {
        counterparty: reId(paramsOf("d79-counterparty-rest")["counterparty"]),
        [field]: param,
      },
    });

  it("sends the d70-edrpou-slip the runtime failed the check on to the LLM", () => {
    expect(whitelisted(resultOf(commandOf("d70-edrpou-slip")), NOW)).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("sends the d70-iban-short the runtime failed the check on to the LLM", () => {
    expect(whitelisted(resultOf(commandOf("d70-iban-short")), NOW)).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("refuses an identifier span the runtime read no value out of", () => {
    expect(planOf(withRequisite("edrpou", { text: "14360570" }))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a typed identifier longer than the action stores", () => {
    expect(
      planOf(
        withRequisite("edrpou", { text: "1436057012", value: "143605701234" }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a typed IBAN longer than the action stores", () => {
    expect(
      planOf(withRequisite("iban", { text: "ua21", value: "UA21".repeat(10) })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("plans the six-digit MFO the runtime typed", () => {
    expect(
      planOf(withRequisite("mfo", { text: "305299", value: "305299" })),
    ).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: COMPANY_IDS["k-nechyporuk"], bankMfo: "305299" },
    });
  });

  it("maps no param beyond the record for the counterparty delete", () => {
    expect(
      planOf(
        asCompanyRecords("d79-counterparty-patronymic", {
          params: {
            counterparty: reId(
              paramsOf("d79-counterparty-patronymic")["counterparty"],
            ),
            comment: paramsOf("d95-named-update")["comment"],
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("a counterparty write binds no record the parse did not resolve", () => {
  it("refuses the catalogue's own counterparty ids, which are no uuids", () => {
    for (const caseId of [
      "d79-counterparty-rest",
      "d79-counterparty-patronymic",
      "d88-this-counterparty",
    ]) {
      expect({ caseId, plan: planOf(commandOf(caseId)) }).toEqual({
        caseId,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("writes to no counterparty an unchecked name stands for", () => {
    expect(planOf(commandOf("d70-rnokpp-ok"))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });
});

describe("a Шо counterparty write only ever reaches the preview", () => {
  const PLANNED = [
    createCounterpartyContract,
    updateCounterpartyContract,
    deleteCounterpartyContract,
  ] as const;

  it("plans only actions whose risk the preview confirms", () => {
    for (const contract of PLANNED) {
      expect({
        action: contract.name,
        pauses: isConfirmableRisk(contract.risk),
      }).toEqual({ action: contract.name, pauses: true });
    }
  });

  it("deletes a counterparty at the high risk the strong preview reads", () => {
    expect({
      risk: deleteCounterpartyContract.risk,
      confirms: deleteCounterpartyContract.requiresConfirmation,
    }).toEqual({ risk: "high", confirms: true });
  });
});

describe("a counterparty write links the CRM customer the parse resolved", () => {
  const LINKED = paramsOf("d95-named-update")["customer"];

  it("plans the create with the linked customer as customerId", () => {
    expect(
      planOf(
        asCompanyRecords("d70-edrpou-ok", {
          params: { ...paramsOf("d70-edrpou-ok"), customer: reId(LINKED) },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_createCounterparty",
      reply: "Контрагента створено.",
      input: {
        name: "приватбанк",
        edrpou: "14360570",
        customerId: COMPANY_IDS["c-honchar"],
      },
    });
  });

  it("plans the update with the linked customer as customerId", () => {
    expect(
      planOf(
        asCompanyRecords("d79-counterparty-rest", {
          params: {
            ...(reId(paramsOf("d79-counterparty-rest")) as Json),
            customer: reId(LINKED),
          },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: {
        id: COMPANY_IDS["k-nechyporuk"],
        phone: "0501112233",
        customerId: COMPANY_IDS["c-honchar"],
      },
    });
  });

  it("links no customer the catalogue's own id stands for, which is no uuid", () => {
    expect(
      planOf(
        asCompanyRecords("d79-counterparty-rest", {
          params: {
            ...(reId(paramsOf("d79-counterparty-rest")) as Json),
            customer: LINKED,
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});
