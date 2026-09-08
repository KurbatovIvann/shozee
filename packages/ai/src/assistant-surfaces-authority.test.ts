import {
  ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX,
  ASSISTANT_SEARCH_RESULTS_HIT_MAX,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
  SEARCH_RESULTS_SURFACE_TOOLS,
} from "@showzy/validation/assistant-surfaces";
import {
  GLOBAL_HIT_CAP,
  SEARCH_LIMIT_PER_TYPE_MAX,
} from "@showzy/validation/search";
import { describe, expect, it } from "vitest";

import { toProviderToolName } from "./action-tool.js";
import { CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT } from "./tool-facades/customers-list-customers.js";
import { ORDERS_CREATE_TOOL_NAME } from "./tool-facades/orders-create.js";
import { ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT } from "./tool-facades/orders-list.js";

describe("assistant surface literals vs authorities (SHO-462)", () => {
  it("keeps the shared list row cap equal to the orders.list façade max", () => {
    expect(ASSISTANT_ORDERS_LIST_ROW_MAX).toBe(
      ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT,
    );
  });

  it("keeps the customers-list row cap equal to the customers.listCustomers façade max", () => {
    expect(ASSISTANT_CUSTOMERS_LIST_ROW_MAX).toBe(
      CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
    );
    expect(ASSISTANT_CUSTOMERS_LIST_ROW_MAX).toBe(7);
    expect(ASSISTANT_CUSTOMERS_LIST_ROW_MAX).not.toBe(
      ASSISTANT_ORDERS_LIST_ROW_MAX,
    );
  });

  it("keeps order-entity surface tools aligned with provider names", () => {
    expect(ORDER_ENTITY_SURFACE_TOOLS).toContain(
      toProviderToolName("orders.get"),
    );
    expect(ORDER_ENTITY_SURFACE_TOOLS).toContain(ORDERS_CREATE_TOOL_NAME);
  });

  it("keeps get/create tool sets containing registry and provider names", () => {
    expect(ORDERS_GET_TOOLS.has("orders.get")).toBe(true);
    expect(ORDERS_GET_TOOLS.has(toProviderToolName("orders.get"))).toBe(true);
    expect(ORDERS_CREATE_TOOLS.has("orders.create")).toBe(true);
    expect(ORDERS_CREATE_TOOLS.has(toProviderToolName("orders.create"))).toBe(
      true,
    );
  });

  it("keeps search-results tools and caps aligned with search.query (SHO-535)", () => {
    expect(SEARCH_RESULTS_SURFACE_TOOLS).toContain(
      toProviderToolName("search.query"),
    );
    expect(SEARCH_RESULTS_SURFACE_TOOLS).toContain("search.query");
    expect(ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX).toBe(
      SEARCH_LIMIT_PER_TYPE_MAX,
    );
    expect(ASSISTANT_SEARCH_RESULTS_HIT_MAX).toBe(GLOBAL_HIT_CAP);
  });
});
