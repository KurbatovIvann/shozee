import { randomUUID } from "node:crypto";

import { type ImplementedAction } from "@showzy/core";
import {
  ConfirmationRequiredError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type IsolationActor,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import {
  companyLegalInfo,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db/schema/companies";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { createCompany } from "./create.js";
import { updateLegal } from "./update-legal.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;
const admin = randomUUID();

const storedIban = "UA111111111111111111111111111";
const foreignIban = "UA999999999999999999999999999";

let kit: TestKit;

async function previewOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
  actor: IsolationActor = {},
): Promise<ActionPreview> {
  const error = await kit
    .invoke(action, input, actor, {
      request: { requireConfirmation: true },
    })
    .then(
      () => {
        throw new Error("expected ConfirmationRequiredError");
      },
      (thrown: unknown) => thrown,
    );
  if (!(error instanceof ConfirmationRequiredError)) {
    throw error;
  }
  const preview = error.challenge.preview;
  if (preview === undefined) {
    throw new Error("expected a structured preview card");
  }
  expect(error.challenge.summary).toBe(preview.title);
  return preview;
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(rolePermissionDefaults).values({
    role: "admin",
    permission: "settings:payments",
  });

  await kit.db.runtime.db.insert(user).values({
    id: admin,
    name: "Admin",
    email: `admin-${admin}@companies-previews.test`,
  });

  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: admin,
    role: "admin",
    permissions: { granted: [], denied: [] },
  });

  await kit.db.runtime.db.insert(companyLegalInfo).values([
    {
      companyId: companyA,
      companyType: "fop",
      legalName: "ФОП Анна",
      edrpou: "12345678",
      iban: storedIban,
    },
    {
      companyId: companyB,
      companyType: "fop",
      legalName: "ФОП Борис",
      iban: foreignIban,
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("companies preview cards (core.md §7)", () => {
  it("previews companies.create from the validated account input", async () => {
    const preview = await previewOf(createCompany, {
      name: "Пекарня Анни",
      slug: "pekarnya-anny",
    });
    expect(preview).toEqual({
      title: "Створити компанію «Пекарня Анни»",
      lines: [
        { label: "Назва", value: "Пекарня Анни" },
        { label: "Публічна адреса", value: "pekarnya-anny" },
      ],
      notes: ["Ви станете власником компанії."],
    });
  });

  it("previews companies.updateLegal as a transition from the stored requisites", async () => {
    const preview = await previewOf(
      updateLegal,
      {
        companyType: "tov",
        legalName: "ТОВ Анна",
        iban: null,
      },
      { userId: admin, companyId: companyA },
    );
    expect(preview.title).toBe("Зберегти реквізити компанії");
    expect(preview.lines).toEqual([
      { label: "Форма", value: "ФОП → ТОВ" },
      { label: "Юридична назва", value: "ФОП Анна → ТОВ Анна" },
      { label: "IBAN", value: `${storedIban} → очистити` },
    ]);
  });

  it("shows every field companies.updateLegal writes, set or cleared", async () => {
    const preview = await previewOf(
      updateLegal,
      {
        companyType: "fop",
        legalName: "ФОП Анна",
        edrpou: null,
        legalAddress: "вул. Хрещатик, 1",
        iban: "",
        bankName: "ПриватБанк",
        bankMfo: "305299",
        bankEdrpou: "14360570",
        phone: "+380501112233",
        email: "anna@example.test",
      },
      { userId: admin, companyId: companyA },
    );
    expect(preview.lines).toEqual([
      { label: "Форма", value: "ФОП" },
      { label: "Юридична назва", value: "ФОП Анна" },
      { label: "ЄДРПОУ", value: "12345678 → очистити" },
      { label: "Юридична адреса", value: "вул. Хрещатик, 1" },
      { label: "IBAN", value: `${storedIban} → очистити` },
      { label: "Банк", value: "ПриватБанк" },
      { label: "МФО", value: "305299" },
      { label: "ЄДРПОУ банку", value: "14360570" },
      { label: "Телефон", value: "+380501112233" },
      { label: "Email", value: "anna@example.test" },
    ]);
  });

  it("never reads another company's stored requisites into the card", async () => {
    const preview = await previewOf(
      updateLegal,
      { companyType: "fop", legalName: "ФОП Анна" },
      { userId: admin, companyId: companyA },
    );
    const values = preview.lines.map((line) => line.value).join(" ");
    expect(values).not.toContain(foreignIban);
    expect(values).not.toContain("Борис");
  });

  it("writes nothing while a card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ value: count() })
      .from(companyLegalInfo)
      .where(eq(companyLegalInfo.companyId, companyA));
    expect(rows[0]?.value).toBe(1);
  });
});
