import { toProviderToolName } from "@showzy/ai";
import { updateLegalContract } from "@showzy/companies/contract";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoCompanyWriteParse } from "./__tests__/company-write-parses.js";
import {
  SHO_COMPANY_WRITE_ACTIONS,
  SHO_COMPANY_WRITE_PLANNERS,
  SHO_COMPANY_WRITE_PLANNER_PARAMS,
  SHO_UPDATE_LEGAL,
} from "./company-writes.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const ANOTHER_COMPANY = "9b7e4a15-03cf-42d6-8714-5ad62c90e38b";

type Json = Record<string, unknown>;

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoCompanyWriteParse(caseId))) as Json;

const paramsOf = (caseId: string): Json => parseOf(caseId)["params"] as Json;

function commandOf(caseId: string, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parseOf(caseId),
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

const UPDATE_LEGAL_TOOL = toProviderToolName(updateLegalContract.name);

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_COMPANY_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no company write planner for ${command.action}`);
  }
  const plan = planner.plan(command, NOW);
  if (plan.kind === "call") {
    expect({
      toolName: plan.toolName,
      accepted: updateLegalContract.input.safeParse(plan.input).success,
    }).toEqual({ toolName: UPDATE_LEGAL_TOOL, accepted: true });
  }
  return plan;
}

const whitelisted = createShoPlanner({
  actions: [...SHO_COMPANY_WRITE_ACTIONS],
});

const CATALOGUE_COMPANY_TYPE = { value: "tov" };

const GOLD_LEGAL_NAME_SPAN = {
  text: (paramsOf("d79-counterparty-legal")["counterparty"] as Json)["text"],
};

const GOLD_ADDRESS = paramsOf("d79-counterparty-legal")["address"];

const GOLD_EDRPOU = paramsOf("d70-edrpou-length")["edrpou"];

const GOLD_IBAN = paramsOf("d70-iban-ok")["iban"];

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

  it("plans the IBAN alone, leaving the stored type and name unnamed (SHO-870)", () => {
    expect(planOf(commandOf("sho-870-legal-iban"))).toEqual({
      kind: "call",
      toolName: "companies_updateLegal",
      reply: "Реквізити оновлено.",
      input: { iban: "UA213223130000026007233566001" },
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
  it("refuses a parse that names no requisite at all", () => {
    expect(
      planOf(
        commandOf("sho-870-legal-iban", { params: {}, needs: [], ready: true }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
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

describe("a legal update is scoped to the verified company alone", () => {
  it("names no company identifier anywhere in the planned input", () => {
    const plan = planOf(updatingLegal());
    const named = plan.kind === "call" ? Object.keys(plan.input) : ["not call"];
    expect(named.filter((key) => /^company(Id|_id)$/i.test(key))).toEqual([]);
  });

  it("takes no tenant identifier from the parse", () => {
    expect(
      planOf(
        updatingLegal({
          company_id: { text: "інша компанія", value: ANOTHER_COMPANY },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("every company write pauses on the preview", () => {
  it("declares the planner as a write", () => {
    expect(
      Object.entries(SHO_COMPANY_WRITE_PLANNERS).map(([action, planner]) => [
        action,
        planner.writes,
      ]),
    ).toEqual([[SHO_UPDATE_LEGAL, true]]);
  });

  it("plans a whitelisted legal update as a write the turn must confirm", () => {
    expect(whitelisted(resultOf(updatingLegal()), NOW)).toEqual({
      kind: "call",
      toolName: "companies_updateLegal",
      reply: "Реквізити оновлено.",
      writes: true,
      input: { companyType: "tov", legalName: "тов сота спейс" },
    });
  });

  it("pauses a field-only legal update on the preview card (SHO-870)", () => {
    expect(whitelisted(resultOf(commandOf("sho-870-legal-iban")), NOW)).toEqual(
      {
        kind: "call",
        toolName: "companies_updateLegal",
        reply: "Реквізити оновлено.",
        writes: true,
        input: { iban: "UA213223130000026007233566001" },
      },
    );
  });

  it("names only params the planner maps", () => {
    expect(SHO_COMPANY_WRITE_PLANNER_PARAMS).toEqual({
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
