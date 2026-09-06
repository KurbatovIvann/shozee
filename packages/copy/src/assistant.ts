/**
 * Staff assistant result-surface chrome shared by mobile (SHO-472).
 *
 * Intersection of collection chrome both locales share. App-only
 * leftovers (sheet title, wait lines, job labels, entity `openOrder`,
 * aggregate copy) stay in the app. Do not "harmonise" those here.
 *
 * Orders list empty/handoff/footnote strings are byte-identical to the
 * leftover keys in `apps/mobile` `i18n/assistant.ts` `cards` so the
 * orders-list staff-visible result does not change.
 */
import { selectCopy, type Locale } from "./locale.js";

export type SharedAssistantOrdersListCopy = {
  readonly listEmptyTitle: string;
  readonly listEmptyDescription: string;
  readonly openList: string;
  readonly customerMatchTruncated: string;
  readonly clipped: string;
};

export type SharedAssistantCustomersListCopy = {
  readonly listEmptyTitle: string;
  readonly listEmptyDescription: string;
  readonly openList: string;
  readonly clipped: string;
};

export type SharedAssistantCopy = {
  readonly ordersList: SharedAssistantOrdersListCopy;
  readonly customersList: SharedAssistantCustomersListCopy;
};

const en: SharedAssistantCopy = {
  ordersList: {
    listEmptyTitle: "No orders",
    listEmptyDescription: "No orders match this request.",
    openList: "Open orders",
    customerMatchTruncated:
      "Customer name matches were truncated. Refine the search or open the list.",
    clipped: "The list was clipped. Open orders to see everything.",
  },
  customersList: {
    listEmptyTitle: "No customers",
    listEmptyDescription: "No customers match this request.",
    openList: "Open customers",
    clipped: "The list was clipped. Open customers to see everything.",
  },
};

const uk: SharedAssistantCopy = {
  ordersList: {
    listEmptyTitle: "Немає замовлень",
    listEmptyDescription: "За цим запитом замовлень немає.",
    openList: "Відкрити замовлення",
    customerMatchTruncated:
      "Збіги за імʼям клієнта обрізано. Уточніть запит або відкрийте список.",
    clipped: "Список обрізано. Відкрийте замовлення, щоб побачити все.",
  },
  customersList: {
    listEmptyTitle: "Немає клієнтів",
    listEmptyDescription: "За цим запитом клієнтів немає.",
    openList: "Відкрити клієнтів",
    clipped: "Список обрізано. Відкрийте клієнтів, щоб побачити все.",
  },
};

export function sharedAssistantCopy(locale: Locale): SharedAssistantCopy {
  return selectCopy(locale, { uk, en });
}
