import { toProviderToolName } from "@showzy/ai";
import { updateLegalContract } from "@showzy/companies/contract";
import { createInviteContract } from "@showzy/invites/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoCompanyWriteParse } from "./__tests__/company-write-parses.js";
import { shoCustomerWriteParse } from "./__tests__/customer-write-parses.js";
import {
  SHO_COMPANY_WRITE_ACTIONS,
  SHO_COMPANY_WRITE_PLANNERS,
  SHO_COMPANY_WRITE_PLANNER_PARAMS,
  SHO_CREATE_INVITE,
  SHO_UPDATE_LEGAL,
  shoInviteExpiresAt,
} from "./company-writes.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const COMPANY_IDS: Readonly<Record<string, string>> = {
  "g-salons": "2a47f5c8-91b0-4d3e-8c62-7e01b9d45f38",
  "g-gamers": "4e5d8b02-1c93-4786-a0f5-29b641e73c8d",
  "pl-partner": "d7420f63-95b8-41ca-8e07-16b3d8205c49",
};

const ANOTHER_COMPANYS_GROUP = "9b7e4a15-03cf-42d6-8714-5ad62c90e38b";

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
  JSON.parse(JSON.stringify(shoCompanyWriteParse(caseId))) as Json;

const paramsOf = (caseId: string): Json => parseOf(caseId)["params"] as Json;

const customerParamsOf = (caseId: string): Json =>
  (JSON.parse(JSON.stringify(shoCustomerWriteParse(caseId))) as Json)[
    "params"
  ] as Json;

function commandOf(caseId: string, patch: Json = {}): ShoCommand {
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
  [toProviderToolName(createInviteContract.name)]: (input) =>
    createInviteContract.input.safeParse(input).success,
  [toProviderToolName(updateLegalContract.name)]: (input) =>
    updateLegalContract.input.safeParse(input).success,
};

function toolAccepts(toolName: string, input: unknown): boolean {
  const accepts = TOOL_INPUTS[toolName];
  if (accepts === undefined) {
    throw new Error(`no action input schema for ${toolName}`);
  }
  return accepts(input);
}

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_COMPANY_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no company write planner for ${command.action}`);
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

const whitelisted = createShoPlanner({
  actions: [...SHO_COMPANY_WRITE_ACTIONS],
});

const CATALOGUE_REUSABLE = { value: "true" };

const CATALOGUE_PERSONAL = { value: "false" };

const CATALOGUE_EXPIRES_IN_A_WEEK = {
  ...(paramsOf("d79-group-for")["expires"] as Json),
  value: "days:7",
};

const CATALOGUE_EXPIRES_IN_A_MONTH = {
  ...(paramsOf("d79-group-new-name")["expires"] as Json),
  value: "date:10-02",
};

const CATALOGUE_COMPANY_TYPE = { value: "tov" };

const CATALOGUE_LEGAL_NAME = paramsOf("d79-counterparty-legal")[
  "counterparty"
] as Json;

const GOLD_LEGAL_NAME_SPAN = { text: CATALOGUE_LEGAL_NAME["text"] };

const GOLD_ADDRESS = paramsOf("d79-counterparty-legal")["address"];

const GOLD_EDRPOU = paramsOf("d70-edrpou-length")["edrpou"];

const GOLD_IBAN = paramsOf("d70-iban-ok")["iban"];

const GOLD_PHONE = customerParamsOf("d94-named-kept")["phone"];

const inviting = (fields: Json): ShoCommand =>
  commandOf("d79-group-for", {
    params: {
      is_reusable: CATALOGUE_REUSABLE,
      expires: CATALOGUE_EXPIRES_IN_A_WEEK,
      ...fields,
    },
  });

const updatingLegal = (fields: Json = {}): ShoCommand =>
  commandOf("d70-edrpou-length", {
    params: {
      company_type: CATALOGUE_COMPANY_TYPE,
      legal_name: GOLD_LEGAL_NAME_SPAN,
      ...fields,
    },
    needs: [],
    ready: true,
  });

beforeAll(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("SHO_COMPANY_WRITE_PLANNERS plans invites.create", () => {
  it("plans d79-group-for on the reusability and the expiry Шо said", () => {
    expect(
      planOf(inviting({ group: reId(paramsOf("d79-group-for")["group"]) })),
    ).toEqual({
      kind: "call",
      toolName: "invites_create",
      reply: "Запрошення створено.",
      input: {
        isReusable: true,
        expiresAt: "2026-09-09T20:59:59.999Z",
        groupId: COMPANY_IDS["g-salons"],
      },
    });
  });

  it("plans a personal d79-group-new-name invite on a dated expiry", () => {
    expect(
      planOf(
        commandOf("d79-group-new-name", {
          params: {
            is_reusable: CATALOGUE_PERSONAL,
            expires: CATALOGUE_EXPIRES_IN_A_MONTH,
            group: reId(paramsOf("d79-group-new-name")["group"]),
            phone: GOLD_PHONE,
          },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "invites_create",
      reply: "Запрошення створено.",
      input: {
        isReusable: false,
        expiresAt: "2026-10-02T20:59:59.999Z",
        groupId: COMPANY_IDS["g-gamers"],
        phone: "0503341290",
      },
    });
  });

  it("names the invitee from new_name and the price list from its id", () => {
    expect(
      planOf(
        inviting({
          new_name: { text: "злата" },
          price_list: {
            text: "партнерський",
            status: "resolved",
            id: COMPANY_IDS["pl-partner"],
          },
        }),
      ),
    ).toEqual({
      kind: "call",
      toolName: "invites_create",
      reply: "Запрошення створено.",
      input: {
        isReusable: true,
        expiresAt: "2026-09-09T20:59:59.999Z",
        name: "злата",
        priceListId: COMPANY_IDS["pl-partner"],
      },
    });
  });
});

describe("an invite never defaults what grants entry", () => {
  it("refuses d79-group-for as Шо parsed it: no canonical expiry", () => {
    expect(planOf(commandOf("d79-group-for"))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses an invite whose reusability Шо left unsaid", () => {
    expect(
      planOf(
        commandOf("d79-group-for", {
          params: { expires: CATALOGUE_EXPIRES_IN_A_WEEK },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("refuses an invite whose expiry Шо left unsaid", () => {
    expect(
      planOf(
        commandOf("d79-group-for", {
          params: { is_reusable: CATALOGUE_REUSABLE },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("refuses a reusability Шо did not type as the boolean enum", () => {
    expect(planOf(inviting({ is_reusable: { text: "багаторазове" } }))).toEqual(
      {
        kind: "fallback",
        reason: "unsupported_param",
      },
    );
  });

  it("refuses an expiry span Шо never canonicalised", () => {
    expect(
      planOf(inviting({ expires: paramsOf("d79-group-for")["expires"] })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses an expiry outside the contract's own window", () => {
    for (const token of ["days:400", "date:02-30", "last_days:7", "тиждень"]) {
      expect({ token, at: shoInviteExpiresAt(token, NOW) }).toEqual({
        token,
        at: null,
      });
    }
    expect(
      shoInviteExpiresAt("days:0", new Date("2026-09-02T20:30:00.000Z")),
    ).toBeNull();
  });

  it("refuses a phone Шо only heard, never normalised", () => {
    expect(planOf(inviting({ phone: { text: "нуль пʼять нуль" } }))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a use cap: the contract couples it to reusability", () => {
    expect(planOf(inviting({ max_uses: { text: "5", value: 5 } }))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });
});

describe("an invite is scoped to the verified company alone", () => {
  it("names no company anywhere in the planned input", () => {
    const plan = planOf(inviting({}));
    const named = plan.kind === "call" ? Object.keys(plan.input) : ["not call"];
    expect(named.filter((key) => /company/i.test(key))).toEqual([]);
  });

  it("takes no tenant identifier from the parse", () => {
    expect(
      planOf(
        inviting({
          company_id: { text: "інша компанія", value: ANOTHER_COMPANYS_GROUP },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("sends a foreign group as the id the owning module must resolve", () => {
    const plan = planOf(
      inviting({
        group: {
          text: "чужа група",
          status: "resolved",
          id: ANOTHER_COMPANYS_GROUP,
        },
      }),
    );
    expect(plan).toEqual({
      kind: "call",
      toolName: "invites_create",
      reply: "Запрошення створено.",
      input: {
        isReusable: true,
        expiresAt: "2026-09-09T20:59:59.999Z",
        groupId: ANOTHER_COMPANYS_GROUP,
      },
    });
  });

  it("refuses a group the parse never resolved to an id", () => {
    expect(
      planOf(
        inviting({
          group: {
            text: "салони",
            status: "ambiguous",
            candidates: [{ id: COMPANY_IDS["g-salons"], name: "Салони" }],
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("SHO_COMPANY_WRITE_PLANNERS plans companies.updateLegal", () => {
  it("plans the type and the legal name the parse carried", () => {
    expect(planOf(updatingLegal())).toEqual({
      kind: "call",
      toolName: "companies_updateLegal",
      reply: "Реквізити оновлено.",
      input: { companyType: "tov", legalName: "тов сота спейс" },
    });
  });

  it("adds only the requisites Шо typed, leaving the rest unchanged", () => {
    expect(
      planOf(updatingLegal({ iban: GOLD_IBAN, address: GOLD_ADDRESS })),
    ).toEqual({
      kind: "call",
      toolName: "companies_updateLegal",
      reply: "Реквізити оновлено.",
      input: {
        companyType: "tov",
        legalName: "тов сота спейс",
        iban: "UA213223130000026007233566001",
        legalAddress: "вулиця бджолина 8",
      },
    });
  });

  it("sends no key for a field the parse never named (SHO-725)", () => {
    const plan = planOf(updatingLegal({ edrpou: GOLD_EDRPOU }));
    expect(plan.kind === "call" ? Object.keys(plan.input).sort() : []).toEqual([
      "companyType",
      "edrpou",
      "legalName",
    ]);
  });
});

describe("a legal update is refused rather than guessed", () => {
  it("refuses d70-edrpou-length as parsed: no type and no legal name", () => {
    expect(planOf(commandOf("d70-edrpou-length"))).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("sends d70-edrpou-length's blocking invalid_value to the LLM", () => {
    expect(whitelisted(resultOf(commandOf("d70-edrpou-length")), NOW)).toEqual({
      kind: "fallback",
      reason: "blocking_need",
    });
  });

  it("refuses an identifier the contract's own schema rejects", () => {
    expect(
      planOf(
        updatingLegal({
          iban: { text: "довгий", value: `UA${"1".repeat(40)}` },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses an identifier Шо heard but never typed", () => {
    for (const param of ["edrpou", "iban", "mfo", "email"]) {
      expect({
        param,
        plan: planOf(updatingLegal({ [param]: { text: "на слух" } })),
      }).toEqual({
        param,
        plan: { kind: "fallback", reason: "unsupported_param" },
      });
    }
  });

  it("refuses a company type outside the contract's enum", () => {
    expect(planOf(updatingLegal({ company_type: { value: "pp" } }))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a bank name: Шо types a slug, not the name on a document", () => {
    expect(
      planOf(updatingLegal({ bank_name: { text: "моно", value: "monobank" } })),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("every company write pauses on the preview", () => {
  it("declares both planners as writes", () => {
    expect(
      Object.entries(SHO_COMPANY_WRITE_PLANNERS).map(([action, planner]) => [
        action,
        planner.writes,
      ]),
    ).toEqual([
      [SHO_CREATE_INVITE, true],
      [SHO_UPDATE_LEGAL, true],
    ]);
  });

  it("plans a whitelisted invite as a write the turn must confirm", () => {
    expect(whitelisted(resultOf(inviting({})), NOW)).toEqual({
      kind: "call",
      toolName: "invites_create",
      reply: "Запрошення створено.",
      writes: true,
      input: { isReusable: true, expiresAt: "2026-09-09T20:59:59.999Z" },
    });
  });

  it("names only params the planners map", () => {
    expect(SHO_COMPANY_WRITE_PLANNER_PARAMS).toEqual({
      [SHO_CREATE_INVITE]: [
        "is_reusable",
        "expires",
        "group",
        "price_list",
        "new_name",
        "phone",
      ],
      [SHO_UPDATE_LEGAL]: [
        "company_type",
        "legal_name",
        "edrpou",
        "address",
        "iban",
        "mfo",
        "phone",
        "email",
      ],
    });
  });
});
