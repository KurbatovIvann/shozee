import { describe, expect, it } from "vitest";

import { detectLocale } from "./locale";
import { pricingCopy } from "./pricing";

describe("pricing copy", () => {
  it("defaults to Ukrainian and picks English only from an en locale", () => {
    expect(pricingCopy(detectLocale()).title).toBe("Прайс-листи");
    expect(pricingCopy(detectLocale("en-US")).title).toBe("Price lists");
  });

  it("keeps uk/en key parity across the namespace", () => {
    const uk = pricingCopy("uk");
    const en = pricingCopy("en");
    expect(Object.keys(uk)).toEqual(Object.keys(en));
    expect(Object.keys(uk.filters)).toEqual(Object.keys(en.filters));
    expect(Object.keys(uk.prices)).toEqual(Object.keys(en.prices));
    expect(Object.keys(uk.empty)).toEqual(Object.keys(en.empty));
    expect(Object.keys(uk.options)).toEqual(Object.keys(en.options));
    expect(Object.keys(uk.confirm)).toEqual(Object.keys(en.confirm));
    expect(Object.keys(uk.toast)).toEqual(Object.keys(en.toast));
    expect(Object.keys(uk.mutation)).toEqual(Object.keys(en.mutation));
    expect(Object.keys(uk.form)).toEqual(Object.keys(en.form));
    expect(Object.keys(uk.form.errors)).toEqual(Object.keys(en.form.errors));
  });

  it("pins canvas price-list copy in uk (name-only search, no assignment line)", () => {
    const uk = pricingCopy("uk");
    expect(uk.searchPlaceholder).toBe("Назва");
    expect(uk.searchLabel).toBe("Пошук прайс-листів");
    expect(uk.createLabel).toBe("Новий прайс-лист");
    expect(uk.filters).toEqual({
      all: "Усі",
      active: "Активні",
      inactive: "Неактивні",
    });
    expect(uk.defaultBadge).toBe("Основний");
    expect(uk.inactiveBadge).toBe("Неактивний");
    expect(uk.empty.catalogTitle).toBe("Прайс-листів ще немає");
    expect(uk.empty.searchTitle).toBe("Нічого не знайдено");
    expect(uk.empty.reset).toBe("Скинути");
    expect(uk.toast.cannotDeactivateDefault).toBe(
      "Спочатку призначте інший основний прайс-лист",
    );
    expect(uk.form.cannotDeactivateDefault).toBe(
      "Спочатку зніміть позначку «основний»",
    );
    expect(uk.form.cannotDeactivateDefault).not.toBe(
      uk.toast.cannotDeactivateDefault,
    );
    expect(uk.form.leaveTitle).toBe("Вийти без збереження?");
    expect(uk.form.leaveDescription).toBe("Внесені зміни буде втрачено.");
    expect(uk.form.leaveContinue).toBe("Продовжити редагування");
    expect(uk.form.leaveConfirm).toBe("Вийти без збереження");
    expect(uk.prices.none).toBe("Без окремих цін");
    expect(uk.hint).toContain("призначеного листа");
    expect(uk.form.createTitle).toBe("Новий прайс-лист");
    expect(uk.form.namePlaceholder).toBe("Наприклад, Опт");
    expect(uk.form.submitCreate).toBe("Створити");
    expect(uk.form.bulkInvalid).toBe("Введіть знижку від 1 до 100%");
    expect(uk.form.archivedBadge).toBe("Архівний");
    expect(uk.form.notFoundTitle).toBe("Прайс-лист не знайдено");
  });

  it("pins editor deactivate-default toast and catalog leave copy in en", () => {
    const en = pricingCopy("en");
    expect(en.toast.cannotDeactivateDefault).toBe(
      "Assign another default price list first",
    );
    expect(en.form.cannotDeactivateDefault).toBe("Turn off “default” first");
    expect(en.form.cannotDeactivateDefault).not.toBe(
      en.toast.cannotDeactivateDefault,
    );
    expect(en.form.leaveTitle).toBe("Leave without saving?");
    expect(en.form.leaveDescription).toBe("Your changes will be lost.");
    expect(en.form.leaveContinue).toBe("Keep editing");
    expect(en.form.leaveConfirm).toBe("Leave without saving");
  });

  it("keeps the interpolation slot in count and confirm templates", () => {
    expect(pricingCopy("uk").prices.one).toContain("{{count}}");
    expect(pricingCopy("en").prices.one).toContain("{{count}}");
    expect(pricingCopy("uk").optionsLabel).toContain("{{name}}");
    expect(pricingCopy("uk").form.bulkApplied).toContain("{{percent}}");
    expect(pricingCopy("uk").form.catalogBaseLabel).toContain("{{price}}");
  });
});
