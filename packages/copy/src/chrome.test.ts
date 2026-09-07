import { describe, expect, it } from "vitest";

import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
} from "./chrome.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

describe("shared form chrome copy", () => {
  it("keeps uk/en key parity on write errors", () => {
    expect(leafPaths(writeErrorsUk)).toEqual(leafPaths(writeErrorsEn));
    for (const path of leafPaths(writeErrorsUk)) {
      const ukValue = leafAt(writeErrorsUk, path);
      const enValue = leafAt(writeErrorsEn, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("keeps uk/en key parity on form chrome", () => {
    expect(leafPaths(formChromeUk)).toEqual(leafPaths(formChromeEn));
    for (const path of leafPaths(formChromeUk)) {
      const ukValue = leafAt(formChromeUk, path);
      const enValue = leafAt(formChromeEn, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("pins write-error strings byte-identical to the former mobile chrome", () => {
    expect(writeErrorsUk).toEqual({
      validation: "Перевірте виділені поля.",
      network: "Не вдалося зберегти. Спробуйте ще раз.",
      offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
      unavailable: "Не вдалося зберегти. Спробуйте ще раз.",
      permission: "Немає права змінювати цей запис.",
    });
    expect(writeErrorsEn).toEqual({
      validation: "Check the highlighted fields.",
      network: "Could not save. Try again.",
      offline: "No connection. Connect and try again.",
      unavailable: "Could not save. Try again.",
      permission: "You do not have permission to change this.",
    });
  });

  it("pins form-chrome strings byte-identical to the former mobile chrome", () => {
    expect(formChromeUk).toEqual({
      cancel: "Скасувати",
      changedLabel: "змінено",
      closeSheet: "Закрити",
      leaveTitle: "Вийти без збереження?",
      leaveDescription: "Внесені зміни буде втрачено.",
      leaveContinue: "Продовжити редагування",
      leaveConfirm: "Вийти без збереження",
      submitCreate: "Створити",
      submitCreateLoading: "Збереження…",
      submitEdit: "Зберегти",
      submitEditLoading: "Збереження…",
    });
    expect(formChromeEn).toEqual({
      cancel: "Cancel",
      changedLabel: "Changed",
      closeSheet: "Close",
      leaveTitle: "Leave without saving?",
      leaveDescription: "Your changes will be lost.",
      leaveContinue: "Keep editing",
      leaveConfirm: "Leave without saving",
      submitCreate: "Create",
      submitCreateLoading: "Saving…",
      submitEdit: "Save",
      submitEditLoading: "Saving…",
    });
  });
});
