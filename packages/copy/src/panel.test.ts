import { describe, expect, it } from "vitest";

import { leafAt, leafPaths } from "./leaf-paths.js";
import { sharedPanelCopy } from "./panel.js";

describe("shared panel copy", () => {
  it("keeps uk/en key parity across the shared tree", () => {
    const uk = sharedPanelCopy("uk");
    const en = sharedPanelCopy("en");
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

  it("does not absorb one-app or wording-divergent panel keys", () => {
    const shared = sharedPanelCopy("uk");
    expect("more" in shared.tabs).toBe(false);
    expect("signOut" in shared).toBe(false);
    expect("placeholderDescription" in shared).toBe(false);
    expect("placeholderTitle" in shared).toBe(false);
    expect("session" in shared).toBe(false);
    expect("userId" in shared).toBe(false);
    expect("companySelector" in shared).toBe(false);
    expect("management" in shared).toBe(false);
    expect("theme" in shared).toBe(false);
    expect("myAccount" in shared).toBe(false);
    expect("notifications" in shared).toBe(false);
    expect("keyboard" in shared).toBe(false);
    expect("help" in shared).toBe(false);
    expect("roles" in shared).toBe(false);
    expect("groupOperations" in shared).toBe(false);
    expect("groupCustomers" in shared).toBe(false);
    expect("groupSettings" in shared).toBe(false);
    expect("moduleHint" in shared).toBe(false);
    expect("mobileNav" in shared).toBe(false);
    expect("aiHint" in shared).toBe(false);
    expect("accountMenu" in shared).toBe(false);
  });

  it("pins shared panel strings byte-identical to both apps", () => {
    expect(sharedPanelCopy("uk")).toEqual({
      navigation: "Основна навігація",
      moduleTitle: "Модуль у розробці",
      documents: "Документи",
      priceLists: "Прайс-листи",
      tabs: {
        orders: "Замовлення",
        products: "Товари",
        ai: "Шозік",
        customers: "Клієнти",
      },
    });
    expect(sharedPanelCopy("en")).toEqual({
      navigation: "Main navigation",
      moduleTitle: "Module in development",
      documents: "Documents",
      priceLists: "Price lists",
      tabs: {
        orders: "Orders",
        products: "Products",
        ai: "Shozik",
        customers: "Customers",
      },
    });
  });
});
