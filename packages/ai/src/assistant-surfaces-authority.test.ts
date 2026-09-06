import {
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ORDER_ENTITY_SURFACE_TOOLS,
  ORDERS_CREATE_TOOLS,
  ORDERS_GET_TOOLS,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { toProviderToolName } from "./action-tool.js";
import { ORDERS_CREATE_TOOL_NAME } from "./tool-facades/orders-create.js";
import { ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT } from "./tool-facades/orders-list.js";

describe("assistant surface literals vs authorities (SHO-462)", () => {
  it("keeps the shared list row cap equal to the orders.list façade max", () => {
    expect(ASSISTANT_ORDERS_LIST_ROW_MAX).toBe(
      ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT,
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
});
