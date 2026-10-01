import { describe, expect, it } from "vitest";

import { detectLocale } from "./locale";
import { customersCopy } from "./customers";

describe("customers copy", () => {
  it("defaults to Ukrainian and picks English only from an en locale", () => {
    expect(customersCopy(detectLocale()).title).toBe("Клієнти");
    expect(customersCopy(detectLocale("en-GB")).title).toBe("Customers");
  });

  it("keeps uk/en key parity across the namespace", () => {
    const uk = customersCopy("uk");
    const en = customersCopy("en");
    expect(Object.keys(uk)).toEqual(Object.keys(en));
    expect(Object.keys(uk.tabs)).toEqual(Object.keys(en.tabs));
    expect(Object.keys(uk.filters)).toEqual(Object.keys(en.filters));
    expect(Object.keys(uk.empty)).toEqual(Object.keys(en.empty));
    expect(Object.keys(uk.confirm)).toEqual(Object.keys(en.confirm));
    expect(Object.keys(uk.mutation)).toEqual(Object.keys(en.mutation));
    expect(Object.keys(uk.editorStub)).toEqual(Object.keys(en.editorStub));
    expect(Object.keys(uk.form)).toEqual(Object.keys(en.form));
    expect(Object.keys(uk.form.errors)).toEqual(Object.keys(en.form.errors));
    expect(Object.keys(uk.groupForm)).toEqual(Object.keys(en.groupForm));
    expect(Object.keys(uk.groupForm.errors)).toEqual(
      Object.keys(en.groupForm.errors),
    );
    expect(Object.keys(uk.counterpartyForm)).toEqual(
      Object.keys(en.counterpartyForm),
    );
    expect(Object.keys(uk.counterpartyForm.errors)).toEqual(
      Object.keys(en.counterpartyForm.errors),
    );
    expect(Object.keys(uk.inviteForm)).toEqual(Object.keys(en.inviteForm));
    expect(Object.keys(uk.inviteForm.errors)).toEqual(
      Object.keys(en.inviteForm.errors),
    );
    expect(Object.keys(uk.counterparties)).toEqual(
      Object.keys(en.counterparties),
    );
    expect(Object.keys(uk.members)).toEqual(Object.keys(en.members));
    expect(Object.keys(uk.inviteStatus)).toEqual(Object.keys(en.inviteStatus));
  });

  it("pins the canvas clients-list copy in uk", () => {
    const uk = customersCopy("uk");
    expect(uk.searchLabel).toBe("Пошук");
    expect(uk.clientsSearchPlaceholder).toBe("Ім’я, телефон або email");
    expect(uk.groupsSearchPlaceholder).toBe("Назва групи");
    expect(uk.counterpartiesSearchPlaceholder).toBe("Назва або ЄДРПОУ");
    expect(uk.createClientLabel).toBe("Новий клієнт");
    expect(uk.createGroupLabel).toBe("Нова група");
    expect(uk.createCounterpartyLabel).toBe("Новий контрагент");
    expect(uk.createInviteLabel).toBe("Нове запрошення");
    expect(uk.tabs).toEqual({
      clients: "Клієнти",
      groups: "Групи",
      counterparties: "Контрагенти",
      invitations: "Запрошення",
    });
    expect(uk.filters).toEqual({ all: "Усі", archived: "Архів" });
    expect(uk.archivedBadge).toBe("В архіві");
    expect(uk.editLabel).toBe("Редагувати");
    expect(uk.restoreLabel).toBe("Відновити");
    expect(uk.empty.catalogTitle).toBe("Клієнтів ще немає");
    expect(uk.empty.archivedTitle).toBe("Архів порожній");
    expect(uk.empty.archivedDescription).toContain("Спочатку архів");
    expect(uk.empty.groupsTitle).toBe("Груп ще немає");
    expect(uk.empty.counterpartiesTitle).toBe("Контрагентів ще немає");
    expect(uk.empty.counterpartiesDescription).toContain("без клієнта");
    expect(uk.empty.invitationsTitle).toBe("Запрошень ще немає");
    expect(uk.empty.invitationsDescription).toContain("Після прийняття");
    expect(uk.inviteStatus.pending).toBe("Активне");
    expect(uk.inviteStatus.exhausted).toBe("Вичерпане");
    expect(uk.confirm.revokeInviteTitle).toBe("Відкликати запрошення?");
    expect(uk.confirm.revokeInviteDescription).toContain("історії запрошень");
    expect(uk.edrpouBadge).toBe("ЄДРПОУ {{edrpou}}");
    expect(uk.confirm.archiveDescription).toContain(
      "Спочатку архів, потім видалення",
    );
    expect(uk.form.contactsHelper).toBe(
      "Потрібен хоча б один контакт: телефон, email або прив’язаний акаунт Шозі.",
    );
    expect(uk.form.counterpartiesTitle).toBe("Юрособи");
    expect(uk.form.counterpartiesCreateHint).toContain("Збережіть клієнта");
    expect(uk.form.counterpartiesEmpty).toBe("Немає прив’язаних контрагентів.");
    expect(uk.form.counterpartiesAdd).toBe("Додати контрагента");
    expect(uk.form.counterpartiesEdrpouEmpty).toBe("Без коду");
    expect(uk.form.priceListInheritGroup).toBe("Успадкований від групи");
    expect(uk.form.assignmentUnavailable).toBe("Призначено");
    expect(uk.form.leaveTitle).toBe("Вийти без збереження?");
    expect(uk.groupForm.aboutTitle).toBe("Про групу");
    expect(uk.groupForm.namePlaceholder).toBe("Наприклад, Оптові покупці");
    expect(uk.groupForm.descriptionLabel).toBe("Опис (необовʼязково)");
    expect(uk.groupForm.memberHint).toContain("У групі {{members}}");
    expect(uk.groupForm.priceListLabel).toBe("Прайс-лист за замовчуванням");
    expect(uk.groupForm.priceListPlaceholder).toBe("Роздрібний");
    expect(uk.groupForm.priceListEmptyOption).toBe("За замовчуванням");
    expect(uk.form.groupEmpty).toBe("Груп не знайдено.");
    expect(uk.form.priceListEmpty).toBe("Прайс-листів не знайдено.");
    expect(uk.counterpartyForm.customerEmpty).toBe("Клієнтів не знайдено.");
    expect(uk.groupForm.errors.nameRequired).toBe("Вкажіть назву групи");
    expect(uk.groupForm.notFoundTitle).toBe("Групу не знайдено");
    expect(uk.editorStub.counterpartyCreateTitle).toBe("Новий контрагент");
    expect(uk.editorStub.invitationCreateTitle).toBe("Нове запрошення");
    expect(uk.inviteForm.whoTitle).toBe("Кому");
    expect(uk.inviteForm.whoHelper).toContain("не для команди");
    expect(uk.inviteForm.createdHelper).toContain("Скопіюйте зараз");
    expect(uk.inviteForm.expiresLabel).toBe("Діє до");
    expect(uk.inviteForm.maxUsesLabel).toBe("Ліміт використань");
    expect(uk.inviteForm.permissionCreateTitle).toBe("Немає права запрошувати");
    expect(uk.counterpartyForm.customerHelper).toContain("Необов’язково");
    expect(uk.counterpartyForm.nameLabel).toBe("Назва контрагента");
    expect(uk.counterpartyForm.edrpouLabel).toBe("ЄДРПОУ");
    expect(uk.counterpartyForm.errors.nameRequired).toBe(
      "Вкажіть назву контрагента",
    );
    expect(uk.counterpartyForm.errors.conflict).toContain("ЄДРПОУ");
    expect(uk.counterpartyForm.openClient).toBe("Відкрити клієнта");
    expect(uk.counterpartyForm.customerEmptyOption).toBe("Без клієнта");
  });

  it("pins linked-account copy with the Shozee product name", () => {
    const uk = customersCopy("uk");
    const en = customersCopy("en");
    expect(en.form.contactsHelper).toBe(
      "At least one contact is required: phone, email, or a linked Shozee account.",
    );
    expect(uk.form.contactsHelper).toBe(
      "Потрібен хоча б один контакт: телефон, email або прив’язаний акаунт Шозі.",
    );
  });

  it("keeps empty counterparty copy aligned with the form helper QES wording", () => {
    const uk = customersCopy("uk");
    const en = customersCopy("en");
    expect(en.form.counterpartiesHelper).toContain("invoices and QES");
    expect(en.empty.counterpartiesDescription).toContain("invoices and QES");
    expect(uk.form.counterpartiesHelper).toContain("рахунків і КЕП");
    expect(uk.empty.counterpartiesDescription).toContain("рахунків і КЕП");
  });
});
