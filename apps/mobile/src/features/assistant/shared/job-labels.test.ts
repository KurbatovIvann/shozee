import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import { assistantJobLabel } from "./job-labels";

const uk = assistantCopy("uk");
const en = assistantCopy("en");

describe("assistantJobLabel", () => {
  it("uses Ukrainian job copy, not the orders_list_page wire name", () => {
    const label = assistantJobLabel("orders_list_page", uk);
    expect(label).toBe("Шукаю замовлення");
    expect(label).not.toBe("orders_list_page");
    expect(label.includes("orders_list_page")).toBe(false);
  });

  it("uses Ukrainian job copy, not the orders_list_counts wire name", () => {
    const label = assistantJobLabel("orders_list_counts", uk);
    expect(label).toBe("Рахую виторг");
    expect(label.includes("orders_list_counts")).toBe(false);
  });

  it("maps dotted search.query to the same label as search_query", () => {
    expect(assistantJobLabel("search.query", uk)).toBe(uk.jobs.search_query);
    expect(assistantJobLabel("search_query", en)).toBe(en.jobs.search_query);
  });

  it("falls back without echoing an unknown wire name", () => {
    const label = assistantJobLabel("customers.deleteCustomer", uk);
    expect(label).toBe("Працюю");
    expect(label.includes("customers.deleteCustomer")).toBe(false);
    expect(label.includes("customers_deleteCustomer")).toBe(false);
  });
});
