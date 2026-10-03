import { describe, expect, it } from "vitest";

import {
  localizeCustomerNameSnapshot,
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
} from "./customer-name";

describe("localizeCustomerNameSnapshot", () => {
  it("keeps the stored snapshot the order was placed for", () => {
    expect(
      localizeCustomerNameSnapshot("Анна Мельник", "Клієнт видалений"),
    ).toBe("Анна Мельник");
  });

  it("localizes only the unlinked sentinel", () => {
    expect(UNLINKED_CUSTOMER_NAME_SNAPSHOT).toBe("unlinked");
    expect(
      localizeCustomerNameSnapshot(
        UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        "Клієнт видалений",
      ),
    ).toBe("Клієнт видалений");
  });
});
