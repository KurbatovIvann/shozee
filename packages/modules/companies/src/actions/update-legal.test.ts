import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPANY_LEGAL_ADDRESS_MAX,
  COMPANY_LEGAL_BANK_EDRPOU_MAX,
  COMPANY_LEGAL_BANK_MFO_MAX,
  COMPANY_LEGAL_BANK_NAME_MAX,
  COMPANY_LEGAL_EDRPOU_MAX,
  COMPANY_LEGAL_EMAIL_MAX,
  COMPANY_LEGAL_IBAN_MAX,
  COMPANY_LEGAL_NAME_MAX,
  COMPANY_LEGAL_PHONE_MAX,
} from "./company-view.contract.js";
import {
  updateLegalContract,
  updateLegalInputSchema,
  updateLegalOutputSchema,
} from "./update-legal.contract.js";

const validUpdate = {
  companyType: "fop" as const,
  legalName: "ФОП Коваленко",
};

const updateLegalSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../services/update-legal.ts"),
  "utf8",
);

describe("companies.updateLegal contract", () => {
  it("is an idempotent audited staff client write with settings:payments and no events", () => {
    expect(updateLegalContract.name).toBe("companies.updateLegal");
    expect(updateLegalContract.principal).toBe("staff");
    expect(updateLegalContract.transport).toBe("client");
    expect(updateLegalContract.risk).toBe("write");
    expect(updateLegalContract.permissions).toEqual(["settings:payments"]);
    expect(updateLegalContract.aiExposure).toBe("exposed");
    expect(updateLegalContract.requiresConfirmation).toBe(false);
    expect(updateLegalContract.idempotent).toBe(true);
    expect(updateLegalContract.audit).toBe(true);
    expect(updateLegalContract.emits).toEqual([]);
    expect(updateLegalContract.atomicCalls).toEqual([]);
    expect(updateLegalContract.atomicCallers).toEqual([]);
    expect(updateLegalContract.timeout).toBe(5_000);
    expect(updateLegalContract.rateLimit).toBeUndefined();
    expect(COMPANY_LEGAL_NAME_MAX).toBe(300);
    expect(COMPANY_LEGAL_EDRPOU_MAX).toBe(10);
    expect(COMPANY_LEGAL_ADDRESS_MAX).toBe(500);
    expect(COMPANY_LEGAL_IBAN_MAX).toBe(34);
    expect(COMPANY_LEGAL_BANK_NAME_MAX).toBe(200);
    expect(COMPANY_LEGAL_BANK_MFO_MAX).toBe(6);
    expect(COMPANY_LEGAL_BANK_EDRPOU_MAX).toBe(8);
    expect(COMPANY_LEGAL_PHONE_MAX).toBe(30);
    expect(COMPANY_LEGAL_EMAIL_MAX).toBe(200);
    expect(Object.keys(updateLegalOutputSchema.shape).toSorted()).toEqual([
      "id",
      "legal",
      "name",
      "prefix",
      "slug",
    ]);
  });

  it("trims the legal name and optional requisites", () => {
    expect(
      updateLegalInputSchema.parse({
        ...validUpdate,
        legalName: "  ТОВ Київські торти  ",
        edrpou: "  12345678  ",
        legalAddress: "  вул. Хрещатик, 1  ",
        iban: "  UA123  ",
        bankName: "  ПриватБанк  ",
        bankMfo: "  300001  ",
        bankEdrpou: "  12345678  ",
        phone: "  +380501112233  ",
        email: "  office@kit.test  ",
      }),
    ).toEqual({
      companyType: "fop",
      legalName: "ТОВ Київські торти",
      edrpou: "12345678",
      legalAddress: "вул. Хрещатик, 1",
      iban: "UA123",
      bankName: "ПриватБанк",
      bankMfo: "300001",
      bankEdrpou: "12345678",
      phone: "+380501112233",
      email: "office@kit.test",
    });
    expect(
      updateLegalInputSchema.parse({
        companyType: "tov",
        legalName: "ТОВ Партнер",
        edrpou: null,
        iban: null,
      }),
    ).toMatchObject({
      companyType: "tov",
      edrpou: null,
      iban: null,
    });
  });

  it("rejects blank legal names, over-max fields, and invalid companyType", () => {
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        legalName: "   ",
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        legalName: "x".repeat(COMPANY_LEGAL_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        edrpou: "1".repeat(COMPANY_LEGAL_EDRPOU_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        legalAddress: "x".repeat(COMPANY_LEGAL_ADDRESS_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        iban: "x".repeat(COMPANY_LEGAL_IBAN_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        bankName: "x".repeat(COMPANY_LEGAL_BANK_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        bankMfo: "1".repeat(COMPANY_LEGAL_BANK_MFO_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        bankEdrpou: "1".repeat(COMPANY_LEGAL_BANK_EDRPOU_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        phone: "1".repeat(COMPANY_LEGAL_PHONE_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        ...validUpdate,
        email: "x".repeat(COMPANY_LEGAL_EMAIL_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        companyType: "llc",
        legalName: "ФОП",
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.safeParse({
        companyType: "",
        legalName: "ФОП",
      }).success,
    ).toBe(false);
    expect(
      updateLegalInputSchema.parse({
        ...validUpdate,
        email: "not-an-email",
      }).email,
    ).toBe("not-an-email");
  });

  it("takes companyType and legalName as omittable, never null (ADR-0033 2026-10-03)", () => {
    expect(updateLegalInputSchema.parse({ iban: "UA123" })).toEqual({
      iban: "UA123",
    });
    expect(updateLegalInputSchema.parse({ companyType: "tov" })).toEqual({
      companyType: "tov",
    });
    expect(Object.keys(updateLegalInputSchema.parse({}))).toEqual([]);
    for (const nulled of [{ companyType: null }, { legalName: null }]) {
      expect(updateLegalInputSchema.safeParse(nulled).success).toBe(false);
    }
  });

  it("rejects identifier fields — the input is strict", () => {
    for (const extra of [
      { companyId: "c" },
      { id: "11111111-1111-4111-8111-111111111111" },
      { name: "Trade name" },
      { slug: "trade-slug" },
      { prefix: "KA" },
      { userId: "u" },
    ]) {
      expect(
        updateLegalInputSchema.safeParse({ ...validUpdate, ...extra }).success,
      ).toBe(false);
    }
  });

  it("merges the input with the locked row before one upsert", () => {
    expect(updateLegalSource).toContain("mergeLegalFields");
    expect(updateLegalSource).toContain('for("update")');
    expect(updateLegalSource).toContain("returning(legalReturning)");
    expect(updateLegalSource).toContain("companyIdentityReturning");
    expect(updateLegalSource).toContain("toCompanyView(company, upserted)");
    expect(updateLegalSource).not.toContain("loadCompanyView");
  });
});
