/**
 * Company settings hub copy (SHO-482).
 *
 * Mobile-only namespace moved wholesale so web can import later instead
 * of copying. Do not invent web strings for these keys. The nested legal
 * editor is a separate tree (`legal.ts`).
 */
import { selectCopy, type Locale } from "../locale.js";

export type SharedCompaniesSettingsCopy = {
  readonly title: string;
  readonly backLabel: string;
  readonly loadingLabel: string;
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly permissionTitle: string;
  readonly permissionDescription: string;
  readonly slugDisplay: string;
  readonly prefixTitle: string;
  readonly prefixExplanation: string;
  readonly documentsSection: string;
  readonly legalLabel: string;
  readonly legalMissing: string;
};

const en: SharedCompaniesSettingsCopy = {
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
};

const uk: SharedCompaniesSettingsCopy = {
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
};

export function sharedCompaniesSettingsCopy(
  locale: Locale,
): SharedCompaniesSettingsCopy {
  return selectCopy(locale, { uk, en });
}
