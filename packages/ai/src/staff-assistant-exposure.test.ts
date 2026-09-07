import {
  listProductsContract,
  setProductImagesContract,
} from "@showzy/catalog/contract";
import type { StaffMembership } from "@showzy/core";
import { listCustomersContract } from "@showzy/customers/contract";
import {
  createOrderContract,
  getOrderContract,
  listOrdersContract,
} from "@showzy/orders/contract";
import { listPriceListsContract } from "@showzy/pricing/contract";
import { describe, expect, it } from "vitest";

import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  staffAssistantHotToolNames,
  staffAssistantTools,
  toProviderToolName,
} from "./action-tool.js";
import { filterStaffAiTools } from "./filter-staff-tools.js";

const owner: StaffMembership = { role: "owner", permissions: [] };

const HOT_TOOL_NAMES = [
  ORDERS_LIST_PAGE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  "orders_get",
  ORDERS_CREATE_TOOL_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
] as const;

describe("SHO-509 staff assistant exposure", () => {
  it("omits catalog.setProductImages from an owner's tool set", () => {
    const filtered = filterStaffAiTools(
      [
        listOrdersContract,
        getOrderContract,
        createOrderContract,
        listProductsContract,
        listPriceListsContract,
        listCustomersContract,
        setProductImagesContract,
      ],
      owner,
    );
    expect(setProductImagesContract.aiExposure).toBe("internal");
    expect(filtered.map((contract) => contract.name)).not.toContain(
      "catalog.setProductImages",
    );

    const names = Object.keys(
      staffAssistantTools(filtered, () => Promise.resolve({})),
    );
    expect(names).not.toContain("catalog_setProductImages");
    expect(names).not.toContain(toProviderToolName("catalog.setProductImages"));
    expect(names.filter((name) => name.startsWith("files_"))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining([...HOT_TOOL_NAMES]));
  });

  it("keeps the advertised hot tool set unchanged", () => {
    expect(staffAssistantHotToolNames()).toEqual([...HOT_TOOL_NAMES]);
    expect(staffAssistantHotToolNames()).not.toContain(
      "catalog_setProductImages",
    );
    expect(staffAssistantHotToolNames()).not.toContain(
      CUSTOMERS_LIST_GROUPS_TOOL_NAME,
    );
  });
});
