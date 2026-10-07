import {
  createProductContract,
  getProductContract,
  listProductsContract,
} from "@showzy/catalog/contract";
import {
  createCounterpartyContract,
  createCustomerContract,
  createGroupContract,
  getCustomerContract,
  getGroupContract,
  listCustomersContract,
  listGroupsContract,
} from "@showzy/customers/contract";
import {
  createOrderContract,
  listOrdersContract,
} from "@showzy/orders/contract";
import {
  createPriceListContract,
  getPriceListContract,
  listPriceListsContract,
} from "@showzy/pricing/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toProviderToolName } from "../action-tool.js";

import { CATALOG_GET_PRODUCT_TOOL_NAME } from "./catalog-get-product.js";
import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  mapCatalogListProductsOutput,
} from "./catalog-list-products.js";
import { CUSTOMERS_GET_CUSTOMER_TOOL_NAME } from "./customers-get-customer.js";
import {
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  mapCustomersListCustomersOutput,
} from "./customers-list-customers.js";
import {
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  mapCustomersListGroupsOutput,
} from "./customers-list-groups.js";
import { ORDERS_CREATE_TOOL_NAME } from "./orders-create.js";
import {
  mapOrdersListPageOutput,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "./orders-list.js";
import {
  mapPricingListPriceListsOutput,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
} from "./pricing-list-price-lists.js";
import {
  STAFF_ASSISTANT_RECORD_SHAPES,
  type StaffAssistantRecordKind,
} from "./records.js";

type Mapper = (output: unknown) => unknown;

interface Mapped {
  readonly tool: string;
  readonly kind: StaffAssistantRecordKind;
  readonly output: z.ZodType;
  readonly map?: Mapper;
}

const MAPPED: readonly Mapped[] = [
  {
    tool: toProviderToolName("catalog.createProduct"),
    kind: "product",
    output: createProductContract.output,
  },
  {
    tool: toProviderToolName("customers.createCounterparty"),
    kind: "counterparty",
    output: createCounterpartyContract.output,
  },
  {
    tool: toProviderToolName("customers.createCustomer"),
    kind: "customer",
    output: createCustomerContract.output,
  },
  {
    tool: toProviderToolName("customers.createGroup"),
    kind: "group",
    output: createGroupContract.output,
  },
  {
    tool: toProviderToolName("pricing.createPriceList"),
    kind: "price_list",
    output: createPriceListContract.output,
  },
  {
    tool: CATALOG_GET_PRODUCT_TOOL_NAME,
    kind: "product",
    output: getProductContract.output,
  },
  {
    tool: CATALOG_LIST_PRODUCTS_TOOL_NAME,
    kind: "product",
    output: listProductsContract.output,
    map: mapCatalogListProductsOutput,
  },
  {
    tool: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
    kind: "customer",
    output: getCustomerContract.output,
  },
  {
    tool: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    kind: "customer",
    output: listCustomersContract.output,
    map: mapCustomersListCustomersOutput,
  },
  {
    tool: toProviderToolName("customers.getGroup"),
    kind: "group",
    output: getGroupContract.output,
  },
  {
    tool: CUSTOMERS_LIST_GROUPS_TOOL_NAME,
    kind: "group",
    output: listGroupsContract.output,
    map: mapCustomersListGroupsOutput,
  },
  {
    tool: ORDERS_CREATE_TOOL_NAME,
    kind: "order",
    output: createOrderContract.output,
  },
  {
    tool: ORDERS_LIST_PAGE_TOOL_NAME,
    kind: "order",
    output: listOrdersContract.output,
    map: mapOrdersListPageOutput,
  },
  {
    tool: toProviderToolName("pricing.getPriceList"),
    kind: "price_list",
    output: getPriceListContract.output,
  },
  {
    tool: PRICING_LIST_PRICE_LISTS_TOOL_NAME,
    kind: "price_list",
    output: listPriceListsContract.output,
    map: mapPricingListPriceListsOutput,
  },
];

function fieldsOf(schema: unknown): Readonly<Record<string, z.ZodType>> {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  if (schema instanceof z.ZodUnion) {
    const object = schema.options.find(
      (option) =>
        option instanceof z.ZodObject &&
        Object.hasOwn(option.shape, "kind") &&
        Object.hasOwn(option.shape, "items"),
    );
    return object instanceof z.ZodObject ? object.shape : {};
  }
  return {};
}

function rowFieldsOf(schema: z.ZodType): Readonly<Record<string, z.ZodType>> {
  const items = fieldsOf(schema)["items"];
  return items instanceof z.ZodArray ? fieldsOf(items.element) : {};
}

const rowsIn = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const page = (row: Readonly<Record<string, string>>): unknown => ({
  kind: "page.summary",
  items: [row],
  nextCursor: null,
  customerMatchTruncated: false,
});

function read(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

describe("every mapped tool's record shape matches what that tool answers", () => {
  it("covers each tool exactly once", () => {
    expect(MAPPED.map((one) => one.tool).toSorted()).toEqual(
      Object.keys(STAFF_ASSISTANT_RECORD_SHAPES).toSorted(),
    );
  });

  it.each(MAPPED)("$tool names fields its action declares", (mapped) => {
    const shape = STAFF_ASSISTANT_RECORD_SHAPES[mapped.tool];
    expect(shape).toBeDefined();
    if (shape === undefined) return;
    expect(shape.kind).toBe(mapped.kind);
    const fields =
      shape.rowsKey === null
        ? fieldsOf(mapped.output)
        : rowFieldsOf(mapped.output);
    expect(Object.keys(fields)).toContain(shape.idKey);
    expect(Object.keys(fields)).toContain(shape.nameKey);
  });

  it.each(MAPPED.filter((one) => one.map !== undefined))(
    "$tool keeps those fields through its output map",
    (mapped) => {
      const shape = STAFF_ASSISTANT_RECORD_SHAPES[mapped.tool];
      expect(shape?.rowsKey).toBeTypeOf("string");
      if (shape?.rowsKey === null || shape === undefined) return;
      const row = { [shape.idKey]: "r-1", [shape.nameKey]: "Назва" };
      const mappedOutput = mapped.map?.(page(row));
      const rows = rowsIn(read(mappedOutput, shape.rowsKey));
      expect(rows).toHaveLength(1);
      expect(read(rows[0], shape.idKey)).toBe("r-1");
      expect(read(rows[0], shape.nameKey)).toBe("Назва");
    },
  );
});
