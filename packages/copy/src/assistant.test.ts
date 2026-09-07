import { describe, expect, it } from "vitest";

import { assistantCopy, sharedAssistantCopy } from "./assistant.js";
import { writeErrorsEn, writeErrorsUk } from "./chrome.js";
import { leafAt, leafPaths } from "./leaf-paths.js";

describe("shared assistant copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    const uk = sharedAssistantCopy("uk");
    const en = sharedAssistantCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = leafAt(uk, path);
      const enValue = leafAt(en, path);
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("does not fold the wholesale sheet onto result-surface chrome", () => {
    const shared = sharedAssistantCopy("uk");
    expect("sheetTitle" in shared).toBe(false);
    expect("emptyTitle" in shared).toBe(false);
    expect("waitLabel" in shared).toBe(false);
    expect("jobs" in shared).toBe(false);
    expect("errors" in shared).toBe(false);
    expect("openOrder" in shared.ordersList).toBe(false);
    expect("orderCount" in shared.ordersList).toBe(false);
    expect("noneBucket" in shared.ordersList).toBe(false);
    expect("aggregateEmptyTitle" in shared.ordersList).toBe(false);
    expect("periodToday" in shared.ordersList).toBe(false);
    expect("openOrder" in shared.customersList).toBe(false);
    expect("customerMatchTruncated" in shared.customersList).toBe(false);
    expect("periodToday" in shared.aggregate).toBe(false);
    expect("orderCount" in shared.aggregate).toBe(false);
    expect("aggregateEmptyTitle" in shared.aggregate).toBe(false);
    expect("noneBucket" in shared.aggregate).toBe(false);
  });

  it("pins breakdown totals and column labels", () => {
    const uk = sharedAssistantCopy("uk").aggregate;
    const en = sharedAssistantCopy("en").aggregate;
    expect(uk.totals).toBe("Разом");
    expect(en.totals).toBe("Total");
    expect(uk.countColumn).toBe("К-сть");
    expect(en.countColumn).toBe("Qty");
    expect(uk.amountColumn).toBe("Сума");
    expect(en.amountColumn).toBe("Amount");
    expect(uk.productColumn).toBe("Товар і варіант");
    expect(uk.statusColumn).toBe("Статус і товар");
    expect(uk.customerColumn).toBe("Замовник і товар");
  });
});

describe("wholesale assistant copy", () => {
  it("keeps uk/en key parity across the wholesale tree", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(leafPaths(uk)).toEqual(leafPaths(en));
    for (const path of leafPaths(uk)) {
      const ukValue = leafAt(uk, path);
      const enValue = leafAt(en, path);
      if (path === "waitIntervalMs") {
        expect(ukValue).toBe(2000);
        expect(enValue).toBe(2000);
        continue;
      }
      expect(typeof ukValue, path).toBe("string");
      expect(typeof enValue, path).toBe("string");
      expect(String(ukValue).length, path).toBeGreaterThan(0);
      expect(String(enValue).length, path).toBeGreaterThan(0);
    }
  });

  it("owns sheet, jobs, cards, and assistant error trees", () => {
    const shared = assistantCopy("uk");
    expect("sheetTitle" in shared).toBe(true);
    expect("jobs" in shared).toBe(true);
    expect("cards" in shared).toBe(true);
    expect("errors" in shared).toBe(true);
    expect("waitLines" in shared).toBe(true);
    expect("openOrder" in shared.cards).toBe(true);
    expect("noneBucket" in shared.cards).toBe(true);
  });

  it("keeps overlapping cards strings byte-identical to ordersList chrome", () => {
    const chromeUk = sharedAssistantCopy("uk").ordersList;
    const chromeEn = sharedAssistantCopy("en").ordersList;
    const cardsUk = assistantCopy("uk").cards;
    const cardsEn = assistantCopy("en").cards;
    expect(cardsUk.listEmptyTitle).toBe(chromeUk.listEmptyTitle);
    expect(cardsUk.listEmptyDescription).toBe(chromeUk.listEmptyDescription);
    expect(cardsUk.openOrders).toBe(chromeUk.openList);
    expect(cardsUk.customerMatchTruncated).toBe(
      chromeUk.customerMatchTruncated,
    );
    expect(cardsUk.clipped).toBe(chromeUk.clipped);
    expect(cardsEn.listEmptyTitle).toBe(chromeEn.listEmptyTitle);
    expect(cardsEn.openOrders).toBe(chromeEn.openList);
    expect(cardsEn.clipped).toBe(chromeEn.clipped);
  });

  it("keeps assistant write-error overrides off chrome writeErrors", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(en.errors.network).not.toBe(writeErrorsEn.network);
    expect(en.errors.unavailable).not.toBe(writeErrorsEn.unavailable);
    expect(en.errors.permission).not.toBe(writeErrorsEn.permission);
    expect(uk.errors.network).not.toBe(writeErrorsUk.network);
    expect(uk.errors.unavailable).not.toBe(writeErrorsUk.unavailable);
    expect(uk.errors.permission).not.toBe(writeErrorsUk.permission);
    expect(uk.cards.noneBucket).not.toBe(
      sharedAssistantCopy("uk").aggregate.totals,
    );
  });
});
