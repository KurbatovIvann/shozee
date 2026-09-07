/**
 * Shared form chrome and write-error strings (SHO-475).
 *
 * Byte-identical uk+en objects used by every staff form namespace.
 * Namespaces that already differ override the differing keys at the
 * spread site. Do not "harmonise" those leftovers here.
 */

export type WriteErrorsCopy = {
  readonly validation: string;
  readonly network: string;
  readonly offline: string;
  readonly unavailable: string;
  readonly permission: string;
};

export type FormChromeCopy = {
  readonly cancel: string;
  readonly changedLabel: string;
  readonly closeSheet: string;
  readonly leaveTitle: string;
  readonly leaveDescription: string;
  readonly leaveContinue: string;
  readonly leaveConfirm: string;
  readonly submitCreate: string;
  readonly submitCreateLoading: string;
  readonly submitEdit: string;
  readonly submitEditLoading: string;
};

export const writeErrorsEn: WriteErrorsCopy = {
  validation: "Check the highlighted fields.",
  network: "Could not save. Try again.",
  offline: "No connection. Connect and try again.",
  unavailable: "Could not save. Try again.",
  permission: "You do not have permission to change this.",
};

export const writeErrorsUk: WriteErrorsCopy = {
  validation: "Перевірте виділені поля.",
  network: "Не вдалося зберегти. Спробуйте ще раз.",
  offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
  unavailable: "Не вдалося зберегти. Спробуйте ще раз.",
  permission: "Немає права змінювати цей запис.",
};

export const formChromeEn: FormChromeCopy = {
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
};

export const formChromeUk: FormChromeCopy = {
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
};
