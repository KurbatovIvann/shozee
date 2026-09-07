import { describe, expect, it } from "vitest";

import {
  sharedCompaniesLegalCopy,
  sharedCompaniesOnboardingCopy,
  sharedCompaniesScopeCopy,
  sharedCompaniesSettingsCopy,
} from "./companies.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

function assertUkEnParity(uk: object, en: object) {
  expect(leafPaths(uk)).toEqual(leafPaths(en));
  for (const path of leafPaths(uk)) {
    const ukValue = leafAt(uk, path);
    const enValue = leafAt(en, path);
    expect(typeof ukValue, path).toBe("string");
    expect(typeof enValue, path).toBe("string");
    expect(String(ukValue).length, path).toBeGreaterThan(0);
    expect(String(enValue).length, path).toBeGreaterThan(0);
  }
}

describe("shared companies onboarding copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    assertUkEnParity(
      sharedCompaniesOnboardingCopy("uk"),
      sharedCompaniesOnboardingCopy("en"),
    );
  });

  it("does not absorb one-app or wording-divergent onboarding keys", () => {
    const shared = sharedCompaniesOnboardingCopy("uk");
    expect("slugHint" in shared).toBe(false);
    expect("slugPreview" in shared).toBe(false);
    expect("companyTitle" in shared).toBe(false);
    expect("companySubtitle" in shared).toBe(false);
    expect("createSubmit" in shared).toBe(false);
    expect("createSubmitLoading" in shared).toBe(false);
    expect("legalTitle" in shared).toBe(false);
    expect("legalSubtitle" in shared).toBe(false);
    expect("legalSkip" in shared).toBe(false);
    expect("stepLabel" in shared).toBe(false);
    expect("typeLabel" in shared).toBe(false);
    expect("offline" in shared.errors).toBe(false);
    expect("validation" in shared.errors).toBe(false);
    expect("tooLong" in shared.errors).toBe(false);
    expect("legalNameRequired" in shared.errors).toBe(false);
    expect("legalNameTooLong" in shared.errors).toBe(false);
  });

  it("pins shared onboarding strings byte-identical to both apps", () => {
    expect(sharedCompaniesOnboardingCopy("uk")).toEqual({
      title: "Про ваш бізнес",
      subtitle: "Основна інформація для створення профілю бізнесу на Шозі.",
      nameLabel: "Назва бізнесу",
      namePlaceholder: "Назва бізнесу",
      slugLabel: "Публічна адреса",
      slugPlaceholder: "vash-biznes",
      submit: "Створити профіль бізнесу",
      submitLoading: "Створюємо…",
      errors: {
        nameRequired: "Вкажіть назву бізнесу",
        nameTooLong: "Назва занадто довга",
        slugInvalid: "Тільки латиниця, цифри та дефіс. Мінімум 3 символи.",
        slugOccupied: "Ця адреса вже зайнята. Оберіть іншу.",
        network: "Помилка мережі. Перевірте з’єднання.",
        unavailable: "Щось пішло не так. Спробуйте ще раз.",
      },
    });
    expect(sharedCompaniesOnboardingCopy("en")).toEqual({
      title: "About your business",
      subtitle: "Basic information to create your business profile on Shozee.",
      nameLabel: "Business name",
      namePlaceholder: "Business name",
      slugLabel: "Public address",
      slugPlaceholder: "your-business",
      submit: "Create business profile",
      submitLoading: "Creating…",
      errors: {
        nameRequired: "Enter a business name",
        nameTooLong: "Name is too long",
        slugInvalid:
          "Latin letters, digits, and hyphen only. At least 3 characters.",
        slugOccupied: "This address is already taken. Choose another.",
        network: "Network error. Check your connection.",
        unavailable: "Something went wrong. Try again.",
      },
    });
  });
});

describe("shared companies settings copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    assertUkEnParity(
      sharedCompaniesSettingsCopy("uk"),
      sharedCompaniesSettingsCopy("en"),
    );
  });

  it("does not absorb legal-editor or other-app keys", () => {
    const shared = sharedCompaniesSettingsCopy("uk");
    expect("legalForm" in shared).toBe(false);
    expect("typeLabel" in shared).toBe(false);
    expect("legalSkip" in shared).toBe(false);
    expect("signOut" in shared).toBe(false);
    expect("slugHint" in shared).toBe(false);
    expect("pickerTitle" in shared).toBe(false);
  });

  it("pins mobile settings hub strings wholesale", () => {
    expect(sharedCompaniesSettingsCopy("uk")).toEqual({
      title: "Компанія",
      backLabel: "Назад",
      loadingLabel: "Завантаження компанії",
      offlineTitle: "Немає зʼєднання",
      offlineDescription:
        "Налаштування компанії недоступні офлайн. Підключіться і спробуйте ще раз.",
      errorTitle: "Не вдалося завантажити компанію",
      errorDescription: "Перевірте з’єднання та спробуйте ще раз.",
      retry: "Повторити",
      permissionTitle: "Немає права",
      permissionDescription:
        "Налаштування компанії доступні власнику та адміністратору.",
      slugDisplay: "shozee.com.ua/{{slug}}",
      prefixTitle: "Префікс номерів",
      prefixExplanation:
        "Замовлення і рахунки нумеруються як {{prefix}}-1048. Код не змінюється.",
      documentsSection: "Документи",
      legalLabel: "Юридичні реквізити",
      legalMissing: "Ще не додано — потрібні для рахунків",
    });
    expect(sharedCompaniesSettingsCopy("en")).toEqual({
      title: "Company",
      backLabel: "Back",
      loadingLabel: "Loading company",
      offlineTitle: "No connection",
      offlineDescription:
        "Company settings are unavailable offline. Connect and try again.",
      errorTitle: "Could not load the company",
      errorDescription: "Check your connection and try again.",
      retry: "Retry",
      permissionTitle: "No permission",
      permissionDescription:
        "Company settings are available to the owner and admin.",
      slugDisplay: "shozee.com.ua/{{slug}}",
      prefixTitle: "Number prefix",
      prefixExplanation:
        "Orders and invoices are numbered {{prefix}}-1048. The code does not change.",
      documentsSection: "Documents",
      legalLabel: "Legal requisites",
      legalMissing: "Not added yet — required for invoices",
    });
  });
});

describe("shared companies legal copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    assertUkEnParity(
      sharedCompaniesLegalCopy("uk"),
      sharedCompaniesLegalCopy("en"),
    );
  });

  it("does not absorb one-app or wording-divergent legal keys", () => {
    const shared = sharedCompaniesLegalCopy("uk");
    expect("edrpouPlaceholder" in shared).toBe(false);
    expect("bankEdrpouLabel" in shared).toBe(false);
    expect("contactsHelper" in shared).toBe(false);
    expect("phoneLabel" in shared).toBe(false);
    expect("submitAdd" in shared).toBe(false);
    expect("submitAddLoading" in shared).toBe(false);
    expect("legalSubmit" in shared).toBe(false);
    expect("legalSkip" in shared).toBe(false);
    expect("companySection" in shared).toBe(false);
    expect("bankSection" in shared).toBe(false);
    expect("legalNameTooLong" in shared.errors).toBe(false);
    expect("tooLong" in shared.errors).toBe(false);
    expect("conflict" in shared.errors).toBe(false);
    expect("validation" in shared.errors).toBe(false);
  });

  it("pins shared legal strings byte-identical to both apps", () => {
    expect(sharedCompaniesLegalCopy("uk")).toEqual({
      typeLabel: "Тип суб’єкта",
      typeFop: "ФОП",
      typeTov: "ТОВ",
      companyTitle: "Інформація про компанію",
      legalNameLabel: "Юридична назва",
      legalNamePlaceholder: "ФОП Прізвище Ім’я По батькові",
      edrpouLabel: "ЄДРПОУ / ІПН",
      legalAddressLabel: "Юридична адреса",
      legalAddressPlaceholder: "м. Київ, вул. Хрещатик, 1",
      bankTitle: "Банківські реквізити",
      ibanLabel: "IBAN",
      ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
      bankNameLabel: "Банк",
      bankNamePlaceholder: "Монобанк",
      bankMfoLabel: "МФО",
      bankMfoPlaceholder: "322001",
      errors: {
        legalNameRequired: "Вкажіть юридичну назву",
      },
    });
    expect(sharedCompaniesLegalCopy("en")).toEqual({
      typeLabel: "Entity type",
      typeFop: "FOP",
      typeTov: "LLC",
      companyTitle: "Company information",
      legalNameLabel: "Legal name",
      legalNamePlaceholder: "FOP Last First Patronymic",
      edrpouLabel: "EDRPOU / TIN",
      legalAddressLabel: "Legal address",
      legalAddressPlaceholder: "Kyiv, Khreshchatyk St, 1",
      bankTitle: "Bank details",
      ibanLabel: "IBAN",
      ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
      bankNameLabel: "Bank",
      bankNamePlaceholder: "Monobank",
      bankMfoLabel: "MFO",
      bankMfoPlaceholder: "322001",
      errors: {
        legalNameRequired: "Enter the legal name",
      },
    });
  });
});

describe("shared companies scope copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    assertUkEnParity(
      sharedCompaniesScopeCopy("uk"),
      sharedCompaniesScopeCopy("en"),
    );
  });

  it("does not absorb one-app or wording-divergent scope keys", () => {
    const shared = sharedCompaniesScopeCopy("uk");
    expect("signOut" in shared).toBe(false);
    expect("multipleTitle" in shared).toBe(false);
    expect("multipleDescription" in shared).toBe(false);
    expect("backToPicker" in shared).toBe(false);
    expect("pickerTitle" in shared).toBe(false);
    expect("pickerHint" in shared).toBe(false);
    expect("unknownTitle" in shared).toBe(false);
    expect("unknownDescription" in shared).toBe(false);
    expect("switcher" in shared).toBe(false);
    expect("retry" in shared).toBe(false);
    expect("errorDescription" in shared).toBe(false);
  });

  it("pins shared scope strings byte-identical to both apps", () => {
    expect(sharedCompaniesScopeCopy("uk")).toEqual({
      loading: "Завантаження вашої компанії",
      errorTitle: "Не вдалося завантажити компанії",
    });
    expect(sharedCompaniesScopeCopy("en")).toEqual({
      loading: "Loading your company",
      errorTitle: "Couldn’t load your companies",
    });
  });
});
