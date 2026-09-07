import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  filterStaffAiTools,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  PROVIDER_TOOL_NAME_PATTERN,
  staffAssistantHotToolNames,
  staffAssistantTools,
  STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  toProviderToolName,
} from "@showzy/ai";
import { PermissionDeniedError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";

import { createActionRegistry } from "../composition.js";
import { readStaffAssistantCompanyTradeName } from "./assistant-chat.js";

const registry = createActionRegistry();
const contracts = registry.contracts();

describe("staff AI tool manifest (SHO-322)", () => {
  it("includes documents.requestSign for documents:edit and hides signing internals", () => {
    const names = filterStaffAiTools(contracts, {
      role: "employee",
      permissions: ["documents:edit", "assistant:use"],
    }).map((contract) => contract.name);

    expect(names).toContain("documents.requestSign");
    expect(names).not.toContain("docSigning.start");
    expect(names).not.toContain("docSigning.complete");
    expect(names).not.toContain("assistant.getStaffActor");
    expect(names).not.toContain("assistant.recordAssistantTurn");
    expect(names).not.toContain("assistant.appendUserMessage");
    expect(names).not.toContain("pricing.resolveProductPrices");
    expect(names.some((name) => name.startsWith("docSigning."))).toBe(false);
    expect(
      contracts.some(
        (contract) =>
          contract.principal === "share" && names.includes(contract.name),
      ),
    ).toBe(false);
    expect(
      contracts.some(
        (contract) =>
          contract.principal === "system" && names.includes(contract.name),
      ),
    ).toBe(false);
  });

  it("lets an owner membership see documents.requestSign via staffHasPermission", () => {
    const names = filterStaffAiTools(contracts, {
      role: "owner",
      permissions: [],
    }).map((contract) => contract.name);
    expect(names).toContain("documents.requestSign");
    expect(names).toContain("orders.list");
    expect(names).toContain("orders.create");
    expect(names).toContain("customers.deleteCustomer");
    expect(names).not.toContain("pricing.resolveProductPrices");
    expect(names).not.toContain("catalog.resolveLineReferences");
    expect(names).not.toContain("customers.resolveCustomerReference");
    expect(names).not.toContain("docSigning.start");
    expect(names).not.toContain("docSigning.complete");
  });

  it("advertises Anthropic-safe ToolSet keys and still dispatches to orders.list", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const filtered = filterStaffAiTools(contracts, {
      role: "owner",
      permissions: [],
    });
    const tools = staffAssistantTools(filtered, execute);
    const names = Object.keys(tools);
    const extraFacadeTools = filtered.some(
      (contract) => contract.name === "orders.list",
    )
      ? 1
      : 0;
    expect(names.length).toBe(filtered.length + 1 + extraFacadeTools);
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    for (const name of names) {
      expect(name).toMatch(PROVIDER_TOOL_NAME_PATTERN);
      expect(name).not.toContain(".");
    }
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("orders.list"));
    expect(names).not.toContain("orders.list");
    expect(names).toContain(CATALOG_LIST_PRODUCTS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("catalog.listProducts"));
    expect(names).not.toContain("catalog_listProducts");
    expect(names).toContain(PRICING_LIST_PRICE_LISTS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("pricing.listPriceLists"));
    expect(names).not.toContain("pricing_listPriceLists");
    expect(names).toContain(CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("customers.listCustomers"));
    expect(names).not.toContain("customers_listCustomers");
    expect(names).toContain(CUSTOMERS_LIST_GROUPS_TOOL_NAME);
    expect(names).not.toContain(toProviderToolName("customers.listGroups"));
    expect(names).not.toContain("customers_listGroups");
    expect(tools[CUSTOMERS_LIST_GROUPS_TOOL_NAME]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
    expect(names).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(names).toContain(toProviderToolName("orders.create"));
    expect(names).not.toContain("orders.create");
    expect(
      tools[toProviderToolName("pricing.createPriceList")]?.providerOptions,
    ).toEqual(STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS);
    expect(
      tools[toProviderToolName("pricing.setPriceListEntries")]?.providerOptions,
    ).toEqual(STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS);
    const listTool = tools[ORDERS_LIST_PAGE_TOOL_NAME];
    expect(listTool).toBeDefined();
    await listTool?.execute?.(
      {},
      { toolCallId: "call-list", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "orders.list",
      expect.objectContaining({ kind: "page.summary" }),
      { toolCallId: "call-list" },
    );
    const createTool = tools[ORDERS_CREATE_TOOL_NAME];
    expect(createTool).toBeDefined();
    expect(createTool?.providerOptions).not.toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
    await createTool?.execute?.(
      {
        customerQuery: "Katya",
        items: [{ productQuery: "Cake", quantityDecimal: "1.5" }],
      },
      { toolCallId: "call-create", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "orders.create",
      {
        customer: { by: "query", value: "Katya" },
        items: [
          {
            product: { by: "query", value: "Cake" },
            variantSelection: { kind: "unspecified" },
            quantity: { decimal: "1.5" },
          },
        ],
      },
      { toolCallId: "call-create" },
    );
  });

  it("SHO-509: owner tool set has no files_* or catalog_setProductImages; hot names stay", () => {
    const filtered = filterStaffAiTools(contracts, {
      role: "owner",
      permissions: [],
    });
    const names = Object.keys(
      staffAssistantTools(filtered, () => Promise.resolve({})),
    );
    expect(names.filter((name) => name.startsWith("files_"))).toEqual([]);
    expect(names).not.toContain("catalog_setProductImages");
    expect(names).not.toContain(toProviderToolName("catalog.setProductImages"));
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(names).toContain(CATALOG_LIST_PRODUCTS_TOOL_NAME);
    expect(names).toContain(PRICING_LIST_PRICE_LISTS_TOOL_NAME);
    expect(names).toContain(CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME);
    expect(staffAssistantHotToolNames()).toEqual([
      ORDERS_LIST_PAGE_TOOL_NAME,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      "orders_get",
      ORDERS_CREATE_TOOL_NAME,
      CATALOG_LIST_PRODUCTS_TOOL_NAME,
      PRICING_LIST_PRICE_LISTS_TOOL_NAME,
      CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    ]);
  });
});

describe("readStaffAssistantCompanyTradeName", () => {
  it("returns the trimmed trade name", async () => {
    await expect(
      readStaffAssistantCompanyTradeName(() =>
        Promise.resolve({ name: "  Качани  " }),
      ),
    ).resolves.toBe("Качани");
  });

  it("omits the name on documents:view permission denial", async () => {
    await expect(
      readStaffAssistantCompanyTradeName(() => {
        throw new PermissionDeniedError();
      }),
    ).resolves.toBeUndefined();
  });

  it("does not swallow other errors", async () => {
    await expect(
      readStaffAssistantCompanyTradeName(() => {
        throw new Error("companies.get failed");
      }),
    ).rejects.toThrow("companies.get failed");
  });
});
