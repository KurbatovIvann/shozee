import { randomUUID } from "node:crypto";

import { type ImplementedAction } from "@showzy/core";
import {
  ConfirmationRequiredError,
  PermissionDeniedError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type IsolationActor,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import { priceLists } from "@showzy/db/schema/pricing";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  DUPLICATE_EMAIL_NOTE,
  DUPLICATE_PHONE_NOTE,
} from "../services/duplicate-contact.js";
import {
  DELETE_COUNTERPARTY_NOTE,
  DELETE_CUSTOMER_NOTE,
  DELETE_GROUP_NOTE,
} from "../services/preview-card.js";
import { archiveCustomer } from "./archive-customer.js";
import { createCounterparty } from "./create-counterparty.js";
import { createCustomer } from "./create-customer.js";
import { createGroup } from "./create-group.js";
import { deleteCounterparty } from "./delete-counterparty.js";
import { deleteCustomer } from "./delete-customer.js";
import { deleteGroup } from "./delete-group.js";
import { restoreCustomer } from "./restore-customer.js";
import { updateCounterparty } from "./update-counterparty.js";
import { updateCustomer } from "./update-customer.js";
import { updateGroup } from "./update-group.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;
const clerkWithoutView = randomUUID();

const fixtures = {
  listA: randomUUID(),
  listA2: randomUUID(),
  listB: randomUUID(),
  groupA: randomUUID(),
  groupA2: randomUUID(),
  groupDeleted: randomUUID(),
  groupB: randomUUID(),
  customerA: randomUUID(),
  customerArchived: randomUUID(),
  customerB: randomUUID(),
  partyA: randomUUID(),
  partyB: randomUUID(),
};

const foreignGroupName = "Чужа група";
const foreignListName = "Чужий прайс";
const foreignCustomerName = "Чужий клієнт";

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

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerkWithoutView,
      name: "Клерк",
      email: "clerk@previews.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerkWithoutView,
      role: "employee",
      permissions: {
        granted: ["customers:create"],
        denied: ["customers:view"],
      },
    },
  ]);

  await kit.db.runtime.db.insert(priceLists).values([
    { id: fixtures.listA, companyId: companyA, name: "Роздріб" },
    { id: fixtures.listA2, companyId: companyA, name: "Опт" },
    { id: fixtures.listB, companyId: companyB, name: foreignListName },
  ]);

  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupA,
      companyId: companyA,
      name: "Оптовики",
      slug: "optovyky",
      description: "Старий опис",
      priceListId: fixtures.listA,
    },
    {
      id: fixtures.groupA2,
      companyId: companyA,
      name: "Вечірні",
      slug: "vechirni",
    },
    {
      id: fixtures.groupDeleted,
      companyId: companyA,
      name: "Застаріла",
      slug: "zastarila",
      description: "Більше не потрібна",
    },
    {
      id: fixtures.groupB,
      companyId: companyB,
      name: foreignGroupName,
      slug: "chuzha-grupa",
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Анна Коваль",
      phone: "+380501112233",
      notes: "VIP",
      groupId: fixtures.groupA,
    },
    {
      id: fixtures.customerArchived,
      companyId: companyA,
      name: "Богдан Мороз",
      email: "bohdan@previews.test",
      status: "archived",
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: foreignCustomerName,
      phone: "+380509999999",
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.partyA,
      companyId: companyA,
      name: "ТОВ Анна",
      edrpou: "12345678",
      iban: "UA111111111111111111111111111",
      customerId: fixtures.customerA,
    },
    {
      id: fixtures.partyB,
      companyId: companyB,
      name: "ТОВ Чуже",
      edrpou: "87654321",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("customers preview cards (ADR-0050, core.md §7)", () => {
  it("shows every column customers.createCustomer writes, named ids resolved", async () => {
    const preview = await previewOf(createCustomer, {
      name: "Нова Клієнтка",
      phone: "+380502223344",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA2,
    });
    expect(preview.title).toBe("Новий клієнт: Нова Клієнтка");
    expect(preview.lines).toEqual([
      { label: "Ім’я", value: "Нова Клієнтка" },
      { label: "Телефон", value: "+380502223344" },
      { label: "Email", value: "—" },
      { label: "Користувач", value: "—" },
      { label: "Нотатки", value: "—" },
      { label: "Група", value: "Оптовики" },
      { label: "Прайс-лист", value: "Опт" },
      { label: "Статус", value: "активний" },
    ]);
    expect(preview.notes).toBeUndefined();
  });

  it("names the existing customer when the caller holds customers:view", async () => {
    const byPhone = await previewOf(createCustomer, {
      name: "Інша Анна",
      phone: "0501112233",
    });
    expect(byPhone.notes).toEqual([`${DUPLICATE_PHONE_NOTE}: Анна Коваль`]);

    const byEmail = await previewOf(createCustomer, {
      name: "Інший Богдан",
      email: "BOHDAN@previews.test",
    });
    expect(byEmail.notes).toEqual([`${DUPLICATE_EMAIL_NOTE}: Богдан Мороз`]);

    for (const note of [...(byPhone.notes ?? []), ...(byEmail.notes ?? [])]) {
      expect(note).not.toContain("0501112233");
      expect(note).not.toContain("bohdan@previews.test");
    }
  });

  it("refuses the whole create when customers:view is explicitly denied, prerequisite of customers:create", async () => {
    await expect(
      kit.invoke(
        createCustomer,
        { name: "Інша Анна", phone: "0501112233" },
        { userId: clerkWithoutView },
        { request: { requireConfirmation: true } },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("never warns about another company's customer", async () => {
    const preview = await previewOf(createCustomer, {
      name: "Нова Клієнтка",
      phone: "+380509999999",
    });
    expect(preview.notes).toBeUndefined();
  });

  it("shows customers.updateCustomer as a transition and omits unnamed fields", async () => {
    const preview = await previewOf(updateCustomer, {
      id: fixtures.customerA,
      name: "Анна Коваль",
      phone: "+380506667788",
      notes: null,
      groupId: fixtures.groupA2,
    });
    expect(preview.title).toBe("Змінити клієнта: Анна Коваль");
    expect(preview.lines).toEqual([
      { label: "Ім’я", value: "Анна Коваль" },
      { label: "Телефон", value: "+380501112233 → +380506667788" },
      { label: "Нотатки", value: "VIP → очистити" },
      { label: "Група", value: "Оптовики → Вечірні" },
    ]);
  });

  it("treats an empty string as a clear on the card", async () => {
    const preview = await previewOf(updateCustomer, {
      id: fixtures.customerA,
      name: "Анна Коваль",
      notes: "",
      groupId: null,
    });
    expect(preview.lines).toEqual([
      { label: "Ім’я", value: "Анна Коваль" },
      { label: "Нотатки", value: "VIP → очистити" },
      { label: "Група", value: "Оптовики → очистити" },
    ]);
  });

  it("previews the status flip for archive and restore", async () => {
    const archive = await previewOf(archiveCustomer, {
      id: fixtures.customerA,
    });
    expect(archive.title).toBe("Архівувати клієнта: Анна Коваль");
    expect(archive.lines).toEqual([
      { label: "Статус", value: "активний → архівований" },
    ]);

    const restore = await previewOf(restoreCustomer, {
      id: fixtures.customerArchived,
    });
    expect(restore.title).toBe("Відновити клієнта: Богдан Мороз");
    expect(restore.lines).toEqual([
      { label: "Статус", value: "архівований → активний" },
    ]);
  });

  it("names the customer, the contact and the consequences on the delete card", async () => {
    const preview = await previewOf(deleteCustomer, {
      id: fixtures.customerArchived,
    });
    expect(preview.title).toBe("Видалити клієнта: Богдан Мороз");
    expect(preview.lines).toEqual([
      { label: "Контакт", value: "bohdan@previews.test" },
      { label: "Статус", value: "архівований" },
    ]);
    expect(preview.notes).toEqual([DELETE_CUSTOMER_NOTE]);
  });

  it("previews group writes with the resolved price list", async () => {
    const created = await previewOf(createGroup, {
      name: "Кафе",
      priceListId: fixtures.listA,
    });
    expect(created.title).toBe("Нова група клієнтів: Кафе");
    expect(created.lines).toEqual([
      { label: "Назва", value: "Кафе" },
      { label: "Опис", value: "—" },
      { label: "Прайс-лист", value: "Роздріб" },
    ]);

    const updated = await previewOf(updateGroup, {
      id: fixtures.groupA,
      name: "Оптовики плюс",
      priceListId: null,
    });
    expect(updated.title).toBe("Змінити групу клієнтів: Оптовики");
    expect(updated.lines).toEqual([
      { label: "Назва", value: "Оптовики → Оптовики плюс" },
      { label: "Прайс-лист", value: "Роздріб → очистити" },
    ]);
  });

  it("counts the active members the group delete card loses", async () => {
    const empty = await previewOf(deleteGroup, { id: fixtures.groupDeleted });
    expect(empty.title).toBe("Видалити групу клієнтів: Застаріла");
    expect(empty.lines).toEqual([{ label: "Активні клієнти", value: "0" }]);
    expect(empty.notes).toEqual([DELETE_GROUP_NOTE]);

    const populated = await previewOf(deleteGroup, { id: fixtures.groupA });
    expect(populated.title).toBe("Видалити групу клієнтів: Оптовики");
    expect(populated.lines).toEqual([{ label: "Активні клієнти", value: "1" }]);
  });

  it("previews counterparty writes with the linked customer name", async () => {
    const created = await previewOf(createCounterparty, {
      name: "ФОП Петро",
      edrpou: "11112222",
      customerId: fixtures.customerA,
    });
    expect(created.title).toBe("Новий контрагент: ФОП Петро");
    expect(created.lines).toEqual([
      { label: "Назва", value: "ФОП Петро" },
      { label: "ЄДРПОУ", value: "11112222" },
      { label: "Юридична адреса", value: "—" },
      { label: "IBAN", value: "—" },
      { label: "Банк", value: "—" },
      { label: "МФО", value: "—" },
      { label: "Телефон", value: "—" },
      { label: "Email", value: "—" },
      { label: "Нотатки", value: "—" },
      { label: "Клієнт", value: "Анна Коваль" },
    ]);

    const updated = await previewOf(updateCounterparty, {
      id: fixtures.partyA,
      name: "ТОВ Анна",
      iban: "UA222222222222222222222222222",
      customerId: null,
    });
    expect(updated.title).toBe("Змінити контрагента: ТОВ Анна");
    expect(updated.lines).toEqual([
      { label: "Назва", value: "ТОВ Анна" },
      {
        label: "IBAN",
        value: "UA111111111111111111111111111 → UA222222222222222222222222222",
      },
      { label: "Клієнт", value: "Анна Коваль → очистити" },
    ]);
  });

  it("names the counterparty on the delete card", async () => {
    const preview = await previewOf(deleteCounterparty, {
      id: fixtures.partyA,
    });
    expect(preview.title).toBe("Видалити контрагента: ТОВ Анна");
    expect(preview.lines).toEqual([{ label: "ЄДРПОУ", value: "12345678" }]);
    expect(preview.notes).toEqual([DELETE_COUNTERPARTY_NOTE]);
  });

  it("never reads another company's names into a card", async () => {
    const preview = await previewOf(updateCustomer, {
      id: fixtures.customerA,
      name: "Анна Коваль",
      groupId: fixtures.groupA,
    });
    const rendered = [
      preview.title,
      ...preview.lines.map((line) => `${line.label} ${line.value}`),
    ].join(" ");
    expect(rendered).not.toContain(foreignGroupName);
    expect(rendered).not.toContain(foreignListName);
    expect(rendered).not.toContain(foreignCustomerName);
  });

  it("writes nothing while cards are issued", async () => {
    const customers = await kit.db.runtime.db
      .select({ value: count() })
      .from(companyCustomers)
      .where(eq(companyCustomers.companyId, companyA));
    const groups = await kit.db.runtime.db
      .select({ value: count() })
      .from(customerGroups)
      .where(eq(customerGroups.companyId, companyA));
    const parties = await kit.db.runtime.db
      .select({ value: count() })
      .from(counterparties)
      .where(eq(counterparties.companyId, companyA));
    expect(customers[0]?.value).toBe(2);
    expect(groups[0]?.value).toBe(3);
    expect(parties[0]?.value).toBe(1);

    const [customer] = await kit.db.runtime.db
      .select({
        phone: companyCustomers.phone,
        notes: companyCustomers.notes,
        groupId: companyCustomers.groupId,
        status: companyCustomers.status,
      })
      .from(companyCustomers)
      .where(eq(companyCustomers.id, fixtures.customerA));
    expect(customer).toEqual({
      phone: "+380501112233",
      notes: "VIP",
      groupId: fixtures.groupA,
      status: "active",
    });

    const [group] = await kit.db.runtime.db
      .select({
        name: customerGroups.name,
        priceListId: customerGroups.priceListId,
      })
      .from(customerGroups)
      .where(eq(customerGroups.id, fixtures.groupA));
    expect(group).toEqual({ name: "Оптовики", priceListId: fixtures.listA });

    const [party] = await kit.db.runtime.db
      .select({
        iban: counterparties.iban,
        customerId: counterparties.customerId,
      })
      .from(counterparties)
      .where(eq(counterparties.id, fixtures.partyA));
    expect(party).toEqual({
      iban: "UA111111111111111111111111111",
      customerId: fixtures.customerA,
    });
  });
});
