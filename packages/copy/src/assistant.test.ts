import { describe, expect, it } from "vitest";

import { sharedAssistantCopy } from "./assistant.js";
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

  it("does not absorb app-only leftover assistant keys", () => {
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
