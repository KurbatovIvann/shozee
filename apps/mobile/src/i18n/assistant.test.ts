import { describe, expect, it } from "vitest";

import { assistantCopy } from "./assistant";
import { writeErrorsEn, writeErrorsUk } from "./copy";
import { detectLocale } from "./locale";
import { panelCopy } from "./panel";

describe("assistant copy", () => {
  it("defaults to Ukrainian and picks English only from an en locale", () => {
    expect(assistantCopy(detectLocale()).sheetTitle).toBe("Шозік");
    expect(assistantCopy(detectLocale("en-US")).sheetTitle).toBe("Shozik");
  });

  it("keeps uk/en key parity across the namespace", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(Object.keys(uk)).toEqual(Object.keys(en));
    expect(Object.keys(uk.errors)).toEqual(Object.keys(en.errors));
    expect(Object.keys(uk.jobs)).toEqual(Object.keys(en.jobs));
    expect(Object.keys(uk.cards)).toEqual(Object.keys(en.cards));
  });

  it("pins Ukrainian job labels that are not façade wire names", () => {
    const uk = assistantCopy("uk");
    expect(uk.jobs.orders_list_page).toBe("Шукаю замовлення");
    expect(uk.jobs.orders_list_counts).toBe("Рахую виторг");
    expect(uk.jobs.orders_list_page).not.toBe("orders_list_page");
    expect(uk.jobs.orders_list_counts).not.toBe("orders_list_counts");
    expect(uk.jobs.fallback).toBe("Працюю");
    expect(uk.jobs.search_query).toBe("Шукаю в компанії");
    expect(uk.jobs.search_query).not.toBe("search_query");
  });

  it("pins Ukrainian list-card copy without an active status chip", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.cards.openOrders).toBe("Відкрити замовлення");
    expect(en.cards.openOrders).toBe("Open orders");
    expect(uk.cards.openOrder).toBe("Відкрити замовлення");
    expect(en.cards.openOrder).toBe("Open order");
    expect(uk.cards.listEmptyTitle).toBe("Немає замовлень");
    expect(uk.cards.customerMatchTruncated.includes("імʼям")).toBe(true);
    expect(JSON.stringify(uk.cards).includes("active")).toBe(false);
    expect(JSON.stringify(en.cards).includes("active")).toBe(false);
  });

  it("pins aggregate-card copy without an active chip or invented Active group", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.cards.noneBucket).toBe("Усього");
    expect(en.cards.noneBucket).toBe("Total");
    expect(uk.cards.noneBucket.includes("Активн")).toBe(false);
    expect(en.cards.noneBucket.includes("Active")).toBe(false);
    expect(uk.cards.orderCount.one).toBe("{{count}} замовлення");
    expect(uk.cards.orderCount.many).toBe("{{count}} замовлень");
    expect(uk.cards.aggregateEmptyTitle).toBe("Немає замовлень");
    expect(uk.cards.bucketsTruncated).toBe("Показано не всі групи.");
    expect(uk.cards.bucketsOmitted.one).toBe("Ще {{count}} група не показано.");
    expect(uk.cards.bucketsOmitted.few).toBe("Ще {{count}} групи не показано.");
    expect(uk.cards.bucketsOmitted.many).toBe("Ще {{count}} груп не показано.");
    expect(en.cards.bucketsOmitted.one).toBe(
      "{{count}} more group is not shown.",
    );
    expect(en.cards.bucketsOmitted.many).toBe(
      "{{count}} more groups are not shown.",
    );
    expect(uk.cards.periodToday).toBe("Сьогодні");
    expect(uk.cards.periodThisWeek).toBe("Цього тижня");
    expect(uk.cards.periodThisMonth).toBe("Цього місяця");
    expect(en.cards.periodToday).toBe("Today");
    expect(en.cards.periodThisWeek).toBe("This week");
    expect(en.cards.periodThisMonth).toBe("This month");
    expect(Object.keys(uk.cards.orderCount)).toEqual(
      Object.keys(en.cards.orderCount),
    );
    expect(Object.keys(uk.cards.bucketsOmitted)).toEqual(
      Object.keys(en.cards.bucketsOmitted),
    );
    expect(JSON.stringify(uk.cards).includes("active")).toBe(false);
    expect(JSON.stringify(en.cards).includes("active")).toBe(false);
  });

  it("pins the locked wait-line pool and interval, not tool-keyed jobs", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.waitIntervalMs).toBe(2000);
    expect(en.waitIntervalMs).toBe(2000);
    expect(uk.waitLines).toEqual([
      "Копаюсь у даних",
      "Напав на слід",
      "Обнюхую записи",
      "Ще копну",
      "Покопаю ще трошечки",
    ]);
    expect(en.waitLines).toEqual([
      "Digging through the data",
      "Picked up a scent",
      "Sniffing around",
      "One more dig",
      "I'll dig a little more",
    ]);
    expect(uk.waitLabel).toBe("Шозік думає");
    expect(en.waitLabel).toBe("Shozik is thinking");
    expect("thinkingLabel" in uk).toBe(false);
    expect("thinkingLabel" in en).toBe(false);
    expect(uk.waitLines).toHaveLength(en.waitLines.length);
    expect(JSON.stringify(uk.waitLines).includes("orders_list")).toBe(false);
    expect(JSON.stringify(en.waitLines).includes("orders_list")).toBe(false);
    expect(uk.waitLines.includes("Шукаю замовлення")).toBe(false);
    expect(uk.waitLines.includes("Рахую виторг")).toBe(false);
  });

  it("pins claimed ChoiceCard recovery copy in Ukrainian and English", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(en.choiceClaimed).toBe(
      "This choice is already in progress. Continue to finish it.",
    );
    expect(uk.choiceClaimed).toBe(
      "Цей вибір уже в процесі. Продовжи, щоб завершити.",
    );
    expect(en.choiceRetry).toBe("Continue");
    expect(uk.choiceRetry).toBe("Продовжити");
    expect(en.choiceExpired).toBe("This choice expired.");
    expect(uk.choiceExpired).toBe("Цей вибір більше недоступний.");
  });

  it("says why a send was refused, naming the card's own cancel action", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.errors.questionOpen).toBe(
      "Спершу дай відповідь на питання вище або скасуй його.",
    );
    expect(en.errors.questionOpen).toBe(
      "Answer the question above or cancel it first.",
    );
    // The way out it names is the button the card actually shows.
    expect(uk.dismissLabel).toBe("Скасувати");
    expect(en.dismissLabel).toBe("Cancel");
  });

  it("pins sheet title Шозік/Shozik and matches the BottomNav label", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.sheetTitle).toBe("Шозік");
    expect(en.sheetTitle).toBe("Shozik");
    expect(panelCopy("uk").tabs.ai).toBe("Шозік");
    expect(panelCopy("en").tabs.ai).toBe("Shozik");
  });

  it("overrides network/unavailable/permission with assistant wording", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(en.errors.network).toBe("Could not reach the assistant. Try again.");
    expect(en.errors.unavailable).toBe(
      "The assistant is unavailable. Try again.",
    );
    expect(en.errors.permission).toBe(
      "You do not have permission to use the assistant.",
    );
    expect(en.errors.notConfigured).toBe("The assistant is not configured.");
    expect(en.errors.network).not.toBe(writeErrorsEn.network);
    expect(en.errors.unavailable).not.toBe(writeErrorsEn.unavailable);
    expect(en.errors.permission).not.toBe(writeErrorsEn.permission);
    expect(uk.errors.network).toBe(
      "Не вдалося звʼязатися з асистентом. Спробуй ще раз.",
    );
    expect(uk.errors.unavailable).toBe("Асистент недоступний. Спробуй ще раз.");
    expect(uk.errors.permission).toBe("Немає права користуватися асистентом.");
    expect(uk.errors.network).not.toBe(writeErrorsUk.network);
    expect(uk.errors.unavailable).not.toBe(writeErrorsUk.unavailable);
    expect(uk.errors.permission).not.toBe(writeErrorsUk.permission);
    expect(Object.keys(uk.errors)).toEqual(Object.keys(en.errors));
  });
});
