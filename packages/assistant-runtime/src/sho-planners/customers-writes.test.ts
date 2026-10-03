import {
  createCustomerContract,
  updateCustomerContract,
} from "@showzy/customers/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoCustomerWriteParse } from "./__tests__/customer-write-parses.js";
import {
  SHO_CUSTOMER_WRITE_ACTIONS,
  SHO_CUSTOMER_WRITE_PLANNERS,
  SHO_CUSTOMER_WRITE_PLANNER_PARAMS,
  SHO_READ_AS_CUSTOMER_UPDATE_NOTE,
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
  JSON.parse(JSON.stringify(shoCustomerWriteParse(caseId))) as Json;

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

function actionAccepts(action: string, input: unknown): boolean {
  if (action === createCustomerContract.name) {
    return createCustomerContract.input.safeParse(input).success;
  }
  if (action === updateCustomerContract.name) {
    return updateCustomerContract.input.safeParse(input).success;
  }
  throw new Error(`no action input schema for ${action}`);
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
      accepted: actionAccepts(command.action, plan.input),
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
