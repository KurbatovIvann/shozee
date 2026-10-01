import { randomUUID } from "node:crypto";

import { type ImplementedAction } from "@showzy/core";
import {
  ConfirmationRequiredError,
  NotFoundError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { customerGroups } from "@showzy/db/schema/customers";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { priceLists } from "@showzy/db/schema/pricing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { createInvite } from "./create.js";
import { revokeInvite } from "./revoke.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  inviteA: randomUUID(),
  inviteB: randomUUID(),
  groupA: randomUUID(),
  groupB: randomUUID(),
  listA: randomUUID(),
  listB: randomUUID(),
  missingId: randomUUID(),
};

const storedExpiresAt = new Date("2099-06-15T09:00:00.000Z");
const futureExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let kit: TestKit;

async function invokeForCard<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(action: ImplementedAction<TInput, TOutput>, input: unknown) {
  return await kit
    .invoke(
      action,
      input,
      {},
      {
        request: { requireConfirmation: true },
      },
    )
    .then(
      () => {
        throw new Error("expected the invocation to stop on a card");
      },
      (thrown: unknown) => thrown,
    );
}

async function previewOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
): Promise<ActionPreview> {
  const error = await invokeForCard(action, input);
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

function expectSameRefusal(foreign: unknown, missing: unknown): void {
  if (
    !(foreign instanceof NotFoundError) ||
    !(missing instanceof NotFoundError)
  ) {
    throw foreign;
  }
  expect(foreign.code).toBe(missing.code);
  expect(foreign.clientMessage).toBe(missing.clientMessage);
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(priceLists).values([
    { id: fixtures.listA, companyId: companyA, name: "Прайс Альфа" },
    { id: fixtures.listB, companyId: companyB, name: "Чужий прайс" },
  ]);
  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupA,
      companyId: companyA,
      name: "Гуртові",
      slug: `hurtovi-${fixtures.groupA}`,
    },
    {
      id: fixtures.groupB,
      companyId: companyB,
      name: "Чужа група",
      slug: `chuzha-${fixtures.groupB}`,
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomerInvites).values([
    {
      id: fixtures.inviteA,
      companyId: companyA,
      invitedBy: kitIdentities.users.anna,
      tokenHash: `hash-${fixtures.inviteA}`,
      isReusable: true,
      maxUses: 5,
      usesCount: 2,
      expiresAt: storedExpiresAt,
      status: "pending",
      name: "Пекарня Оксани",
    },
    {
      id: fixtures.inviteB,
      companyId: companyB,
      invitedBy: kitIdentities.users.anna,
      tokenHash: `hash-${fixtures.inviteB}`,
      isReusable: false,
      maxUses: 1,
      usesCount: 0,
      expiresAt: storedExpiresAt,
      status: "pending",
      name: "Чужий клієнт",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("invites preview cards (core.md §7)", () => {
  it("previews invites.create from the validated input", async () => {
    const preview = await previewOf(createInvite, {
      isReusable: false,
      expiresAt: futureExpiresAt.toISOString(),
      name: "Нова пекарня",
    });
    expect(preview.title).toBe("Створити запрошення для клієнта");
    expect(preview.lines.slice(0, 3)).toEqual([
      { label: "Тип", value: "Персональне" },
      { label: "Ім'я", value: "Нова пекарня" },
      { label: "Використань", value: "1" },
    ]);
    expect(preview.lines[3]?.label).toBe("Діє до");
    expect(preview.lines[3]?.value).toMatch(
      /^\d{2}\.\d{2}\.\d{4}\D+\d{2}:\d{2}$/,
    );
    expect(preview.lines.slice(4)).toEqual([
      { label: "Телефон", value: "—" },
      { label: "Email", value: "—" },
      { label: "Група", value: "—" },
      { label: "Прайс-лист", value: "—" },
    ]);
    expect(preview.notes).toEqual([
      "Посилання з таємним кодом буде показано один раз.",
    ]);
  });

  it("names the group and price list the invite grants", async () => {
    const preview = await previewOf(createInvite, {
      isReusable: true,
      expiresAt: futureExpiresAt.toISOString(),
      phone: "+380501112233",
      email: "oksana@example.test",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });
    expect(preview.lines.slice(4)).toEqual([
      { label: "Телефон", value: "+380501112233" },
      { label: "Email", value: "oksana@example.test" },
      { label: "Група", value: "Гуртові" },
      { label: "Прайс-лист", value: "Прайс Альфа" },
    ]);
  });

  it("refuses a foreign group in the create card exactly like a missing one", async () => {
    expectSameRefusal(
      await invokeForCard(createInvite, {
        isReusable: true,
        expiresAt: futureExpiresAt.toISOString(),
        groupId: fixtures.groupB,
      }),
      await invokeForCard(createInvite, {
        isReusable: true,
        expiresAt: futureExpiresAt.toISOString(),
        groupId: fixtures.missingId,
      }),
    );
  });

  it("refuses a foreign price list in the create card exactly like a missing one", async () => {
    expectSameRefusal(
      await invokeForCard(createInvite, {
        isReusable: true,
        expiresAt: futureExpiresAt.toISOString(),
        priceListId: fixtures.listB,
      }),
      await invokeForCard(createInvite, {
        isReusable: true,
        expiresAt: futureExpiresAt.toISOString(),
        priceListId: fixtures.missingId,
      }),
    );
  });

  it("previews invites.revoke from the stored invite", async () => {
    const preview = await previewOf(revokeInvite, { id: fixtures.inviteA });
    expect(preview.title).toBe("Відкликати запрошення для Пекарня Оксани");
    expect(preview.lines.slice(0, 3)).toEqual([
      { label: "Тип", value: "Багаторазове" },
      { label: "Статус", value: "Чинне" },
      { label: "Використань", value: "2 / 5" },
    ]);
    expect(preview.lines[3]?.label).toBe("Діє до");
    expect(preview.lines[3]?.value).toContain("15.06.2099");
    expect(preview.lines[3]?.value).toContain("12:00");
  });

  it("leaves the invite untouched while the card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ status: companyCustomerInvites.status })
      .from(companyCustomerInvites)
      .where(eq(companyCustomerInvites.id, fixtures.inviteA));
    expect(rows[0]?.status).toBe("pending");
  });

  it("keeps another company's invite name out of the card", async () => {
    const refusal = await invokeForCard(revokeInvite, { id: fixtures.inviteB });
    expect(refusal).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(refusal)).not.toContain("Чужий клієнт");
  });
});
