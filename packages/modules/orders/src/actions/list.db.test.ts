import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companies, companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { RECORD_VERIFICATION } from "@showzy/validation/record-verification";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { listOrders } from "./list.js";
import {
  formatListOrdersCursor,
  LIST_ORDERS_SUMMARY_MAX_LIMIT,
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
  type ListOrdersOutput,
} from "./list.contract.js";

const pageSummary = { kind: "page.summary" } as const;

const fixtures = {
  emptyCompany: randomUUID(),
  truncCompany: randomUUID(),
  linesCompany: randomUUID(),
  customerA: randomUUID(),
  customerExtra: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productGadget: randomUUID(),
  productB: randomUUID(),
  confirmed: randomUUID(),
  inProgress: randomUUID(),
  done: randomUUID(),
  newestNew: randomUUID(),
  eurNew: randomUUID(),
  sameProductOldTitle: randomUUID(),
  canceled: randomUUID(),
  orphaned: randomUUID(),
  foreign: randomUUID(),
  itemConfirmed: randomUUID(),
  itemInProgress: randomUUID(),
  itemDone: randomUUID(),
  itemNewestNew1: randomUUID(),
  itemNewestNew2: randomUUID(),
  itemEurNew: randomUUID(),
  itemOldTitle: randomUUID(),
  itemCanceled: randomUUID(),
  itemOrphaned: randomUUID(),
  itemForeign: randomUUID(),
};

const clerkUserId = randomUUID();
const noCustomersUserId = randomUUID();

const timestamps = {
  orphaned: new Date("2026-01-01T00:00:00.000Z"),
  canceled: new Date("2026-02-01T00:00:00.000Z"),
  sameProductOldTitle: new Date("2026-02-15T00:00:00.000Z"),
  newestNew: new Date("2026-03-01T00:00:00.000Z"),
  eurNew: new Date("2026-03-15T00:00:00.000Z"),
  confirmed: new Date("2026-04-01T00:00:00.000Z"),
  inProgress: new Date("2026-04-15T00:00:00.000Z"),
  done: new Date("2026-04-20T00:00:00.000Z"),
  foreign: new Date("2026-05-01T00:00:00.000Z"),
};

let kit: TestKit;

function asSummary(result: ListOrdersOutput) {
  expect(result.kind).toBe("page.summary");
  if (result.kind !== "page.summary") {
    throw new Error("expected page.summary");
  }
  return result;
}

function asWithLines(result: ListOrdersOutput) {
  expect(result.kind).toBe("page.withLines");
  if (result.kind !== "page.withLines") {
    throw new Error("expected page.withLines");
  }
  return result;
}

function asAggregate(result: ListOrdersOutput) {
  expect(result.kind).toBe("aggregate");
  if (result.kind !== "aggregate") {
    throw new Error("expected aggregate");
  }
  return result;
}

function statusBucketStatuses(
  result: Extract<ListOrdersOutput, { kind: "aggregate" }>,
) {
  return result.statusBuckets
    .map((bucket) => bucket.identity.status)
    .toSorted();
}

function productBucket(
  result: Extract<ListOrdersOutput, { kind: "aggregate" }>,
  productId: string,
) {
  return result.buckets.find(
    (bucket) =>
      bucket.identity.kind === "product" &&
      bucket.identity.productId === productId &&
      bucket.identity.variantId === null,
  );
}

async function insertOrder(values: {
  id: string;
  itemIds: readonly string[];
  companyId: string;
  customerId: string | null;
  customerNameSnapshot: string;
  productId: string;
  status: "new" | "confirmed" | "in_progress" | "done" | "canceled";
  totalGrossMinor: bigint;
  createdAt: Date;
  orderNumber: string;
  currency?: "UAH" | "EUR";
  titleSnapshot?: string;
  quantityMilli?: bigint;
  createdVia?: "ui" | "ai" | "system" | "webhook" | null;
  vouchedBy?: string | null;
  vouchedAt?: Date | null;
}): Promise<void> {
  const currency = values.currency ?? "UAH";
  const requiresConfirmedAt =
    values.status === "confirmed" ||
    values.status === "in_progress" ||
    values.status === "done";
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: values.customerId,
    customerNameSnapshot: values.customerNameSnapshot,
    status: values.status,
    totalNetMinor: values.totalGrossMinor,
    totalTaxMinor: 0n,
    totalGrossMinor: values.totalGrossMinor,
    currency,
    confirmedAt: requiresConfirmedAt ? values.createdAt : undefined,
    createdAt: values.createdAt,
    updatedAt: values.createdAt,
    createdVia: values.createdVia,
    vouchedBy: values.vouchedBy,
    vouchedAt: values.vouchedAt,
  });
  const perLine = values.totalGrossMinor / BigInt(values.itemIds.length);
  await kit.db.runtime.db.insert(orderItems).values(
    values.itemIds.map((itemId, index) => ({
      id: itemId,
      companyId: values.companyId,
      orderId: values.id,
      productId: values.productId,
      titleSnapshot: values.titleSnapshot ?? "Seed",
      quantityMilli: values.quantityMilli ?? 1000n,
      unitPriceMinor: perLine,
      taxTreatment: "exempt" as const,
      netAmountMinor: perLine,
      grossAmountMinor: perLine,
      priceSource: "base" as const,
      resolverVersion: 1,
      currency,
      createdAt: new Date(values.createdAt.getTime() + index),
    })),
  );
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(companies).values([
    {
      id: fixtures.emptyCompany,
      name: "Empty orders list",
      slug: "empty-orders-list-sho351",
      prefix: "O3",
    },
    {
      id: fixtures.truncCompany,
      name: "Truncation orders list",
      slug: "trunc-orders-list-sho351",
      prefix: "O8",
    },
    {
      id: fixtures.linesCompany,
      name: "Lines truncation orders list",
      slug: "lines-orders-list-sho351",
      prefix: "O9",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: fixtures.emptyCompany,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: fixtures.truncCompany,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: fixtures.linesCompany,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
  ]);

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      phone: "+380111111111",
      email: "alpha-orders-list@example.com",
    },
    {
      id: fixtures.customerExtra,
      companyId: companyA,
      name: "Customer Extra",
      phone: "+380333333333",
      email: "extra-orders-list@example.com",
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      phone: "+380222222222",
      email: "beta-orders-list@example.com",
    },
  ]);

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: companyA,
      name: "Cake",
      basePriceMinor: 1500n,
    },
    {
      id: fixtures.productGadget,
      companyId: companyA,
      name: "Gadget",
      basePriceMinor: 800n,
    },
    {
      id: fixtures.productB,
      companyId: companyB,
      name: "Foreign cake",
      basePriceMinor: 100n,
    },
  ]);

  await insertOrder({
    id: fixtures.orphaned,
    itemIds: [fixtures.itemOrphaned],
    companyId: companyA,
    customerId: null,
    customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
    productId: fixtures.productA,
    status: "new",
    totalGrossMinor: 100n,
    createdAt: timestamps.orphaned,
    orderNumber: "KA-ORPH",
    titleSnapshot: "Orphan widget",
  });
  await insertOrder({
    id: fixtures.canceled,
    itemIds: [fixtures.itemCanceled],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "canceled",
    totalGrossMinor: 200n,
    createdAt: timestamps.canceled,
    orderNumber: "KA-CANC",
    titleSnapshot: "Canceled widget",
  });
  await insertOrder({
    id: fixtures.sameProductOldTitle,
    itemIds: [fixtures.itemOldTitle],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "new",
    totalGrossMinor: 400n,
    createdAt: timestamps.sameProductOldTitle,
    orderNumber: "KA-OLD1",
    titleSnapshot: "Widget · old title",
    quantityMilli: 2000n,
  });
  await insertOrder({
    id: fixtures.newestNew,
    itemIds: [fixtures.itemNewestNew1, fixtures.itemNewestNew2],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "new",
    totalGrossMinor: 1500n,
    createdAt: timestamps.newestNew,
    orderNumber: "KA-NEW1",
    titleSnapshot: "Widget · mid",
  });
  await insertOrder({
    id: fixtures.eurNew,
    itemIds: [fixtures.itemEurNew],
    companyId: companyA,
    customerId: fixtures.customerExtra,
    customerNameSnapshot: "Customer Extra",
    productId: fixtures.productGadget,
    status: "new",
    totalGrossMinor: 800n,
    createdAt: timestamps.eurNew,
    orderNumber: "KA-EUR1",
    currency: "EUR",
    titleSnapshot: "Gadget EUR",
  });
  await insertOrder({
    id: fixtures.confirmed,
    itemIds: [fixtures.itemConfirmed],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "confirmed",
    totalGrossMinor: 400n,
    createdAt: timestamps.confirmed,
    orderNumber: "KA-K7X2",
    titleSnapshot: "Widget · latest",
    quantityMilli: 3000n,
  });
  await insertOrder({
    id: fixtures.inProgress,
    itemIds: [fixtures.itemInProgress],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "in_progress",
    totalGrossMinor: 300n,
    createdAt: timestamps.inProgress,
    orderNumber: "KA-PROG",
    titleSnapshot: "Widget · in progress",
  });
  await insertOrder({
    id: fixtures.done,
    itemIds: [fixtures.itemDone],
    companyId: companyA,
    customerId: fixtures.customerA,
    customerNameSnapshot: "Customer A",
    productId: fixtures.productA,
    status: "done",
    totalGrossMinor: 500n,
    createdAt: timestamps.done,
    orderNumber: "KA-DONE",
    titleSnapshot: "Widget · done",
  });
  await insertOrder({
    id: fixtures.foreign,
    itemIds: [fixtures.itemForeign],
    companyId: companyB,
    customerId: fixtures.customerB,
    customerNameSnapshot: "Customer B",
    productId: fixtures.productB,
    status: "new",
    totalGrossMinor: 999n,
    createdAt: timestamps.foreign,
    orderNumber: "MB-FRGN",
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerkUserId,
      name: "Clerk",
      email: "clerk@orders-list-kit.test",
    },
    {
      id: noCustomersUserId,
      name: "No customers view",
      email: "nocustomers@orders-list-kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerkUserId,
      role: "employee",
      permissions: { granted: [], denied: ["orders:view"] },
    },
    {
      companyId: companyA,
      userId: noCustomersUserId,
      role: "employee",
      permissions: {
        granted: ["orders:view"],
        denied: ["customers:view"],
      },
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      listOrders,
      { input: pageSummary },
      {
        input: pageSummary,
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
    isolationCase(
      listOrders,
      { input: { kind: "aggregate", groupBy: "none" } },
      {
        input: { kind: "aggregate", groupBy: "none" },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("orders.list", () => {
  afterEach(() => {
    RECORD_VERIFICATION.mode = "narrow";
  });

  it("happy path page.summary: newest-first snapshot customer, itemCount, totals", async () => {
    const result = asSummary(await kit.invoke(listOrders, pageSummary));

    expect(result.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.eurNew,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
      fixtures.orphaned,
    ]);
    expect(result.nextCursor).toBeNull();
    expect(result.customerMatchTruncated).toBe(false);

    const confirmed = result.items.find(
      (row) => row.orderId === fixtures.confirmed,
    );
    expect(confirmed).toEqual({
      orderId: fixtures.confirmed,
      orderNumber: "KA-K7X2",
      customer: {
        nameSnapshot: "Customer A",
        linkedCustomerId: fixtures.customerA,
      },
      status: "confirmed",
      itemCount: 1,
      totalGrossMinor: "400",
      currency: "UAH",
      createdAt: timestamps.confirmed.toISOString(),
    });

    const newestNew = result.items.find(
      (row) => row.orderId === fixtures.newestNew,
    );
    expect(newestNew?.itemCount).toBe(2);
    expect(newestNew?.totalGrossMinor).toBe("1500");

    const orphaned = result.items.find(
      (row) => row.orderId === fixtures.orphaned,
    );
    expect(orphaned?.customer).toEqual({
      nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      linkedCustomerId: null,
    });

    const blob = JSON.stringify(result);
    expect(blob).not.toContain("titleSnapshot");
    expect(blob).not.toContain("unitPriceMinor");
    expect(blob).not.toContain("confirmedAt");
    expect(blob).not.toContain("Staff note");
    expect(blob).not.toContain("Deleted customer");
  });

  it("filters statuses[] single, multi, and omit", async () => {
    const news = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { statuses: ["new"] },
      }),
    );
    expect(news.items.map((row) => row.orderId)).toEqual([
      fixtures.eurNew,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.orphaned,
    ]);
    expect(news.items.every((row) => row.status === "new")).toBe(true);

    const multi = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { statuses: ["new", "canceled"] },
      }),
    );
    expect(multi.items.map((row) => row.orderId)).toEqual([
      fixtures.eurNew,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
      fixtures.orphaned,
    ]);

    const omit = asSummary(await kit.invoke(listOrders, pageSummary));
    expect(omit.items).toHaveLength(8);
    expect(new Set(omit.items.map((row) => row.status))).toEqual(
      new Set(["new", "confirmed", "in_progress", "done", "canceled"]),
    );

    const fulfillment = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { statuses: ["in_progress", "done"] },
      }),
    );
    expect(fulfillment.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
    ]);
    expect(
      fulfillment.items.every(
        (row) => row.status === "in_progress" || row.status === "done",
      ),
    ).toBe(true);

    const empty = asSummary(
      await kit.invoke(listOrders, pageSummary, {
        companyId: fixtures.emptyCompany,
      }),
    );
    expect(empty).toEqual({
      kind: "page.summary",
      items: [],
      nextCursor: null,
      customerMatchTruncated: false,
    });
  });

  it("composes date, customerIds, and query isolation", async () => {
    const dateAndCustomer = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: {
          customerIds: [fixtures.customerExtra],
          createdFrom: "2026-03-01T00:00:00.000Z",
          createdTo: "2026-03-20T00:00:00.000Z",
        },
      }),
    );
    expect(dateAndCustomer.items.map((row) => row.orderId)).toEqual([
      fixtures.eurNew,
    ]);

    const customerAOnly = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { customerIds: [fixtures.customerA] },
      }),
    );
    expect(customerAOnly.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
    ]);

    const queryAndCustomer = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: {
          query: "Customer A",
          customerIds: [fixtures.customerA],
        },
      }),
    );
    expect(queryAndCustomer.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
    ]);

    const queryMissesCustomerIds = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: {
          query: "Customer A",
          customerIds: [fixtures.customerExtra],
        },
      }),
    );
    expect(queryMissesCustomerIds.items).toEqual([]);

    const numberAndForeignCustomer = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: {
          query: "KA-EUR1",
          customerIds: [fixtures.customerA],
        },
      }),
    );
    expect(numberAndForeignCustomer.items).toEqual([]);
  });

  it("paginates on createdAt/id and stops at the last page", async () => {
    const first = asSummary(
      await kit.invoke(listOrders, { kind: "page.summary", limit: 2 }),
    );
    expect(first.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
    ]);
    expect(first.nextCursor).toBe(
      formatListOrdersCursor(timestamps.inProgress, fixtures.inProgress),
    );

    const second = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        limit: 2,
        cursor: first.nextCursor ?? "",
      }),
    );
    expect(second.items.map((row) => row.orderId)).toEqual([
      fixtures.confirmed,
      fixtures.eurNew,
    ]);
    expect(second.nextCursor).toBeTruthy();

    const third = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        limit: 2,
        cursor: second.nextCursor ?? "",
      }),
    );
    expect(third.items.map((row) => row.orderId)).toEqual([
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
    ]);
    expect(third.nextCursor).toBeTruthy();

    const fourth = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        limit: 2,
        cursor: third.nextCursor ?? "",
      }),
    );
    expect(fourth.items.map((row) => row.orderId)).toEqual([
      fixtures.canceled,
      fixtures.orphaned,
    ]);
    expect(fourth.nextCursor).toBeNull();
  });

  it("does not include another company's orders or leak a foreign cursor", async () => {
    const result = asSummary(await kit.invoke(listOrders, pageSummary));
    expect(result.items.map((row) => row.orderId)).not.toContain(
      fixtures.foreign,
    );
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(fixtures.foreign);
    expect(blob).not.toContain(kitIdentities.companies.b);

    const fromForeign = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        cursor: formatListOrdersCursor(timestamps.foreign, fixtures.foreign),
      }),
    );
    expect(fromForeign.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.eurNew,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
      fixtures.orphaned,
    ]);
    expect(JSON.stringify(fromForeign)).not.toContain(fixtures.foreign);
  });

  it("denies staff without orders:view", async () => {
    await expect(
      kit.invoke(listOrders, pageSummary, {
        userId: clerkUserId,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "none" },
        {
          userId: clerkUserId,
          companyId: kitIdentities.companies.a,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects missing kind, a bad cursor, and an oversized limit", async () => {
    await expect(kit.invoke(listOrders, {})).rejects.toBeInstanceOf(
      ValidationError,
    );

    await expect(
      kit.invoke(listOrders, {
        kind: "page.summary",
        cursor: "not-a-cursor",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listOrders, {
        kind: "page.summary",
        limit: LIST_ORDERS_SUMMARY_MAX_LIMIT + 1,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listOrders, { kind: "page.summary", limit: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(listOrders, {
        kind: "aggregate",
        filter: { statuses: ["active"] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("matches query by full text number, #prefix, token fragment, customer name, and phone", async () => {
    const byNumber = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "KA-K7X2" },
      }),
    );
    expect(byNumber.items.map((row) => row.orderId)).toEqual([
      fixtures.confirmed,
    ]);
    expect(byNumber.customerMatchTruncated).toBe(false);

    const byHash = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "#KA-K7X2" },
      }),
    );
    expect(byHash.items.map((row) => row.orderId)).toEqual([
      fixtures.confirmed,
    ]);

    const byToken = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "K7X2" },
      }),
    );
    expect(byToken.items.map((row) => row.orderId)).toEqual([
      fixtures.confirmed,
    ]);

    const byCase = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "ka-k7x2" },
      }),
    );
    expect(byCase.items.map((row) => row.orderId)).toEqual([
      fixtures.confirmed,
    ]);

    const byName = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "  Customer   A  " },
      }),
    );
    expect(byName.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
    ]);

    const byPhone = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "111111" },
      }),
    );
    expect(byPhone.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
    ]);
  });

  it("returns an empty page for wildcard-stripped query and keeps status filter", async () => {
    const wildcards = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "%%" },
      }),
    );
    const escaped = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "\\" },
      }),
    );
    const hashOnly = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "#" },
      }),
    );
    const emptyPage = {
      kind: "page.summary" as const,
      items: [],
      nextCursor: null,
      customerMatchTruncated: false,
    };
    expect(wildcards).toEqual(emptyPage);
    expect(escaped).toEqual(emptyPage);
    expect(hashOnly).toEqual(emptyPage);

    const noMatch = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "no-such-order" },
      }),
    );
    expect(noMatch).toEqual(emptyPage);

    const newOnly = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "Customer A", statuses: ["new"] },
      }),
    );
    expect(newOnly.items.map((row) => row.orderId)).toEqual([
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
    ]);
  });

  it("does not leak another tenant's number, name, or phone through query", async () => {
    const emptyPage = {
      kind: "page.summary" as const,
      items: [],
      nextCursor: null,
      customerMatchTruncated: false,
    };
    expect(
      asSummary(
        await kit.invoke(listOrders, {
          kind: "page.summary",
          filter: { query: "MB-FRGN" },
        }),
      ),
    ).toEqual(emptyPage);
    expect(
      asSummary(
        await kit.invoke(listOrders, {
          kind: "page.summary",
          filter: { query: "FRGN" },
        }),
      ),
    ).toEqual(emptyPage);
    expect(
      asSummary(
        await kit.invoke(listOrders, {
          kind: "page.summary",
          filter: { query: "Customer B" },
        }),
      ),
    ).toEqual(emptyPage);
    expect(
      asSummary(
        await kit.invoke(listOrders, {
          kind: "page.summary",
          filter: { query: "222222" },
        }),
      ),
    ).toEqual(emptyPage);

    const byOwnNumber = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "#KA-ORPH" },
      }),
    );
    expect(byOwnNumber.items.map((row) => row.orderId)).toEqual([
      fixtures.orphaned,
    ]);
  });

  it("fails closed when any query needs customers.listMatchingIds without customers:view", async () => {
    const listed = asSummary(
      await kit.invoke(listOrders, pageSummary, {
        userId: noCustomersUserId,
        companyId: kitIdentities.companies.a,
      }),
    );
    expect(listed.items.map((row) => row.orderId)).toEqual([
      fixtures.done,
      fixtures.inProgress,
      fixtures.confirmed,
      fixtures.eurNew,
      fixtures.newestNew,
      fixtures.sameProductOldTitle,
      fixtures.canceled,
      fixtures.orphaned,
    ]);

    await expect(
      kit.invoke(
        listOrders,
        { kind: "page.summary", filter: { query: "Customer A" } },
        { userId: noCustomersUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      kit.invoke(
        listOrders,
        { kind: "page.summary", filter: { query: "KA-K7X2" } },
        { userId: noCustomersUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("page.withLines returns compact lines without looping orders.get", async () => {
    const listed = asWithLines(
      await kit.invoke(listOrders, {
        kind: "page.withLines",
        filter: { statuses: ["new"] },
        limit: 2,
      }),
    );
    expect(listed.items.map((row) => row.orderId)).toEqual([
      fixtures.eurNew,
      fixtures.newestNew,
    ]);
    expect(listed.linesTruncated).toBe(false);
    expect(listed.items[0]?.lines).toEqual([
      expect.objectContaining({
        itemId: fixtures.itemEurNew,
        productId: fixtures.productGadget,
        variantId: null,
        titleSnapshot: "Gadget EUR",
        quantityMilli: "1000",
        grossAmountMinor: "800",
        currency: "EUR",
      }),
    ]);
    expect(listed.items[1]?.lines).toHaveLength(2);
  });

  it("aggregate groupBy product uses (productId, variantId), not titleSnapshot", async () => {
    const byProduct = asAggregate(
      await kit.invoke(listOrders, { kind: "aggregate", groupBy: "product" }),
    );
    const widget = productBucket(byProduct, fixtures.productA);
    expect(widget?.orderCount).toBe(7);
    expect(widget?.label).toBe("Widget · done");
    expect(widget?.identity).toEqual({
      kind: "product",
      productId: fixtures.productA,
      variantId: null,
    });
    expect(
      widget && "quantityMilli" in widget ? widget.quantityMilli : undefined,
    ).toBe("11000");
    expect(
      widget?.grossByCurrency.find((row) => row.currency === "UAH")
        ?.grossAmountMinor,
    ).toBe("3400");

    const gadget = productBucket(byProduct, fixtures.productGadget);
    expect(gadget?.orderCount).toBe(1);
    expect(gadget?.label).toBe("Gadget EUR");
    expect(
      gadget && "quantityMilli" in gadget ? gadget.quantityMilli : undefined,
    ).toBe("1000");

    expect(byProduct.orderCount).toBe(8);
    expect(byProduct.grossByCurrency).toEqual([
      { currency: "EUR", grossAmountMinor: "800" },
      { currency: "UAH", grossAmountMinor: "3400" },
    ]);
    expect(byProduct.bucketsTruncated).toBe(false);
    expect(byProduct.buckets.map((bucket) => bucket.label)).not.toContain(
      "Widget · old title",
    );
  });

  it("aggregate groupBy status, customer, and none follow identity rules", async () => {
    const byStatus = asAggregate(
      await kit.invoke(listOrders, {
        kind: "aggregate",
        groupBy: "status",
        filter: { statuses: ["new", "confirmed"] },
      }),
    );
    expect(
      byStatus.buckets
        .map((bucket) =>
          bucket.identity.kind === "status" ? bucket.identity.status : null,
        )
        .toSorted(),
    ).toEqual(["confirmed", "new"]);
    expect(
      byStatus.buckets.every((bucket) => !("quantityMilli" in bucket)),
    ).toBe(true);

    const byCustomer = asAggregate(
      await kit.invoke(listOrders, { kind: "aggregate", groupBy: "customer" }),
    );
    expect(
      byCustomer.buckets.some(
        (bucket) =>
          bucket.identity.kind === "customer" &&
          bucket.identity.customerId === fixtures.customerA,
      ),
    ).toBe(true);
    const unlinked = byCustomer.buckets.find(
      (bucket) =>
        bucket.identity.kind === "customer" &&
        bucket.identity.customerId === null,
    );
    expect(unlinked?.identity).toEqual({
      kind: "customer",
      customerId: null,
      nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
    });
    expect(unlinked?.orderCount).toBe(1);
    expect(unlinked && "quantityMilli" in unlinked).toBe(false);

    const none = asAggregate(
      await kit.invoke(listOrders, { kind: "aggregate", groupBy: "none" }),
    );
    expect(none.buckets).toHaveLength(1);
    expect(none.buckets[0]?.identity).toEqual({ kind: "none" });
    expect(none.buckets[0]?.orderCount).toBe(8);
    expect(none.orderCount).toBe(8);
    expect(none.buckets[0] && "quantityMilli" in none.buckets[0]).toBe(false);
    expect(statusBucketStatuses(none)).toEqual([
      "canceled",
      "confirmed",
      "done",
      "in_progress",
      "new",
    ]);
  });

  it("always includes currency-safe statusBuckets on every aggregate groupBy", async () => {
    const groupBys = ["none", "status", "product", "customer"] as const;
    for (const groupBy of groupBys) {
      const listed = asAggregate(
        await kit.invoke(listOrders, { kind: "aggregate", groupBy }),
      );
      expect(statusBucketStatuses(listed)).toEqual([
        "canceled",
        "confirmed",
        "done",
        "in_progress",
        "new",
      ]);
      expect(listed.statusBuckets).toHaveLength(5);
      const byNew = listed.statusBuckets.find(
        (bucket) => bucket.identity.status === "new",
      );
      expect(byNew?.orderCount).toBe(4);
      expect(byNew?.grossByCurrency).toEqual([
        { currency: "EUR", grossAmountMinor: "800" },
        { currency: "UAH", grossAmountMinor: "2000" },
      ]);
      expect(JSON.stringify(byNew).includes("2800")).toBe(false);
      expect(
        listed.statusBuckets.every((bucket) => !("quantityMilli" in bucket)),
      ).toBe(true);
    }

    const empty = asAggregate(
      await kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "none" },
        { companyId: fixtures.emptyCompany },
      ),
    );
    expect(empty.orderCount).toBe(0);
    expect(empty.buckets).toHaveLength(1);
    expect(empty.buckets[0]?.identity).toEqual({ kind: "none" });
    expect(empty.statusBuckets).toEqual([]);

    const filtered = asAggregate(
      await kit.invoke(listOrders, {
        kind: "aggregate",
        groupBy: "status",
        filter: { statuses: ["new", "confirmed"] },
      }),
    );
    expect(statusBucketStatuses(filtered)).toEqual(["confirmed", "new"]);
    expect(
      filtered.buckets.map((bucket) =>
        bucket.identity.kind === "status" ? bucket.identity.status : null,
      ),
    ).toEqual(filtered.statusBuckets.map((bucket) => bucket.identity.status));
  });

  it("eval 1: active-order product quantities use one aggregate", async () => {
    const evalActive = asAggregate(
      await kit.invoke(listOrders, {
        kind: "aggregate",
        groupBy: "product",
        filter: { statuses: ["new", "confirmed"] },
      }),
    );
    const widget = productBucket(evalActive, fixtures.productA);
    expect(widget?.orderCount).toBe(4);
    expect(
      widget && "quantityMilli" in widget ? widget.quantityMilli : undefined,
    ).toBe("8000");
    expect(
      evalActive.buckets.some((bucket) => bucket.label === "Canceled widget"),
    ).toBe(false);
  });

  it("eval 2: gross in a date range uses one aggregate groupBy none", async () => {
    const evalGross = asAggregate(
      await kit.invoke(listOrders, {
        kind: "aggregate",
        groupBy: "none",
        filter: {
          createdFrom: "2026-02-15T00:00:00.000Z",
          createdTo: "2026-03-20T00:00:00.000Z",
        },
      }),
    );
    expect(evalGross.orderCount).toBe(3);
    expect(evalGross.grossByCurrency).toEqual([
      { currency: "EUR", grossAmountMinor: "800" },
      { currency: "UAH", grossAmountMinor: "1900" },
    ]);
  });

  it("does not call orders.get from the list query", () => {
    const sources = ["index.ts", "filter.ts", "page.ts", "aggregate.ts"].map(
      (name) =>
        readFileSync(
          new URL(`../services/order-list/${name}`, import.meta.url),
          "utf8",
        ),
    );
    const source = sources.join("\n");
    expect(source).not.toMatch(/\bgetOrder\b/);
    expect(source).not.toMatch(/orders\.get/);
  });

  it("page.withLines sets linesTruncated when compact lines exceed 200", async () => {
    const orderId = randomUUID();
    const productId = randomUUID();
    await kit.db.runtime.db.insert(products).values({
      id: productId,
      companyId: fixtures.linesCompany,
      name: "Trunc product",
      basePriceMinor: 1n,
    });
    await kit.db.runtime.db.insert(orders).values({
      id: orderId,
      companyId: fixtures.linesCompany,
      orderNumber: "O9-LINE",
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      status: "new",
      totalNetMinor: 0n,
      totalTaxMinor: 0n,
      totalGrossMinor: 0n,
      currency: "UAH",
    });
    await kit.db.runtime.db.insert(orderItems).values(
      Array.from({ length: 201 }, () => ({
        id: randomUUID(),
        companyId: fixtures.linesCompany,
        orderId,
        productId,
        titleSnapshot: "Line",
        quantityMilli: 1000n,
        unitPriceMinor: 1n,
        taxTreatment: "exempt" as const,
        netAmountMinor: 1n,
        grossAmountMinor: 1n,
        priceSource: "base" as const,
        resolverVersion: 1,
      })),
    );
    const listed = asWithLines(
      await kit.invoke(
        listOrders,
        { kind: "page.withLines" },
        { companyId: fixtures.linesCompany },
      ),
    );
    expect(listed.linesTruncated).toBe(true);
    expect(listed.items[0]?.lines).toHaveLength(200);
  });

  it("aggregate product bucketsTruncated when more than 50 identities", async () => {
    const orderId = randomUUID();
    const productRows = Array.from({ length: 51 }, () => ({
      id: randomUUID(),
      companyId: fixtures.truncCompany,
      name: "P",
      basePriceMinor: 1n,
    }));
    await kit.db.runtime.db.insert(products).values(productRows);
    await kit.db.runtime.db.insert(orders).values({
      id: orderId,
      companyId: fixtures.truncCompany,
      orderNumber: "O8-BUCK",
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      status: "new",
      totalNetMinor: 0n,
      totalTaxMinor: 0n,
      totalGrossMinor: 0n,
      currency: "UAH",
    });
    await kit.db.runtime.db.insert(orderItems).values(
      productRows.map((product, index) => ({
        id: randomUUID(),
        companyId: fixtures.truncCompany,
        orderId,
        productId: product.id,
        titleSnapshot: `P${String(index)}`,
        quantityMilli: 1000n,
        unitPriceMinor: 1n,
        taxTreatment: "exempt" as const,
        netAmountMinor: 1n,
        grossAmountMinor: 1n,
        priceSource: "base" as const,
        resolverVersion: 1,
      })),
    );
    const listed = asAggregate(
      await kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "product" },
        { companyId: fixtures.truncCompany },
      ),
    );
    expect(listed.buckets).toHaveLength(50);
    expect(listed.bucketsTruncated).toBe(true);
  });

  it("customerMatchTruncated when CRM match exceeds 500", async () => {
    await kit.db.runtime.db.insert(companyCustomers).values(
      Array.from({ length: 501 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `MatchCap ${String(index)}`,
        email: `matchcap-orders-${String(index)}@kit.test`,
        status: "active" as const,
      })),
    );
    const listed = asSummary(
      await kit.invoke(listOrders, {
        kind: "page.summary",
        filter: { query: "MatchCap" },
      }),
    );
    expect(listed.customerMatchTruncated).toBe(true);
  });

  it("merges unlinked aggregate buckets that share the snapshot name", async () => {
    const companyId = randomUUID();
    const productId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await kit.db.runtime.db.insert(companies).values({
      id: companyId,
      name: "Unlinked merge",
      slug: "unlinked-merge-sho351",
      prefix: "UM",
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    });
    await kit.db.runtime.db.insert(products).values({
      id: productId,
      companyId,
      name: "Merge product",
      basePriceMinor: 1n,
    });
    await insertOrder({
      id: firstId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: "Same unlinked",
      productId,
      status: "new",
      totalGrossMinor: 100n,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      orderNumber: "UM-ONE1",
    });
    await insertOrder({
      id: secondId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: "Same unlinked",
      productId,
      status: "new",
      totalGrossMinor: 50n,
      createdAt: new Date("2026-06-02T00:00:00.000Z"),
      orderNumber: "UM-TWO2",
    });
    const listed = asAggregate(
      await kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "customer" },
        { companyId },
      ),
    );
    expect(listed.buckets).toHaveLength(1);
    expect(listed.buckets[0]?.identity).toEqual({
      kind: "customer",
      customerId: null,
      nameSnapshot: "Same unlinked",
    });
    expect(listed.buckets[0]?.orderCount).toBe(2);
    expect(listed.orderCount).toBe(2);
  });

  it("aggregate groupBy none is byte-identical under the narrow default", async () => {
    const none = asAggregate(
      await kit.invoke(listOrders, { kind: "aggregate", groupBy: "none" }),
    );
    const expected = {
      kind: "aggregate",
      orderCount: 8,
      grossByCurrency: [
        { currency: "EUR", grossAmountMinor: "800" },
        { currency: "UAH", grossAmountMinor: "3400" },
      ],
      buckets: [
        {
          identity: { kind: "none" },
          label: "",
          orderCount: 8,
          grossByCurrency: [
            { currency: "EUR", grossAmountMinor: "800" },
            { currency: "UAH", grossAmountMinor: "3400" },
          ],
        },
      ],
      bucketsTruncated: false,
      customerMatchTruncated: false,
      statusBuckets: [
        {
          identity: { kind: "status", status: "new" },
          label: "new",
          orderCount: 4,
          grossByCurrency: [
            { currency: "EUR", grossAmountMinor: "800" },
            { currency: "UAH", grossAmountMinor: "2000" },
          ],
        },
        {
          identity: { kind: "status", status: "canceled" },
          label: "canceled",
          orderCount: 1,
          grossByCurrency: [{ currency: "UAH", grossAmountMinor: "200" }],
        },
        {
          identity: { kind: "status", status: "confirmed" },
          label: "confirmed",
          orderCount: 1,
          grossByCurrency: [{ currency: "UAH", grossAmountMinor: "400" }],
        },
        {
          identity: { kind: "status", status: "done" },
          label: "done",
          orderCount: 1,
          grossByCurrency: [{ currency: "UAH", grossAmountMinor: "500" }],
        },
        {
          identity: { kind: "status", status: "in_progress" },
          label: "in_progress",
          orderCount: 1,
          grossByCurrency: [{ currency: "UAH", grossAmountMinor: "300" }],
        },
      ],
    };
    expect(JSON.stringify(none)).toBe(JSON.stringify(expected));
  });

  it("flipping RECORD_VERIFICATION.mode changes aggregate totals with no other source edited", async () => {
    const companyId = randomUUID();
    const productId = randomUUID();
    const prefix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const uiId = randomUUID();
    const aiUnvouchedId = randomUUID();
    const systemId = randomUUID();
    const unknownId = randomUUID();
    const aiVouchedId = randomUUID();
    await kit.db.runtime.db.insert(companies).values({
      id: companyId,
      name: "Provenance totals",
      slug: `prov-${prefix.toLowerCase()}`,
      prefix,
    });
    await kit.db.runtime.db.insert(companyMembers).values({
      companyId,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    });
    await kit.db.runtime.db.insert(products).values({
      id: productId,
      companyId,
      name: "Provenance product",
      basePriceMinor: 1n,
    });
    const at = new Date("2026-07-01T00:00:00.000Z");
    await insertOrder({
      id: uiId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      productId,
      status: "new",
      totalGrossMinor: 100n,
      createdAt: at,
      orderNumber: `${prefix}-UI1`,
      createdVia: "ui",
    });
    await insertOrder({
      id: aiUnvouchedId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      productId,
      status: "new",
      totalGrossMinor: 200n,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      orderNumber: `${prefix}-AI1`,
      createdVia: "ai",
    });
    await insertOrder({
      id: systemId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      productId,
      status: "new",
      totalGrossMinor: 500n,
      createdAt: new Date("2026-07-02T12:00:00.000Z"),
      orderNumber: `${prefix}-SYS`,
      createdVia: "system",
    });
    await insertOrder({
      id: unknownId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      productId,
      status: "new",
      totalGrossMinor: 300n,
      createdAt: new Date("2026-07-03T00:00:00.000Z"),
      orderNumber: `${prefix}-UNK`,
      createdVia: null,
    });
    await insertOrder({
      id: aiVouchedId,
      itemIds: [randomUUID()],
      companyId,
      customerId: null,
      customerNameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
      productId,
      status: "new",
      totalGrossMinor: 400n,
      createdAt: new Date("2026-07-04T00:00:00.000Z"),
      orderNumber: `${prefix}-AIV`,
      createdVia: "ai",
      vouchedBy: kitIdentities.users.anna,
      vouchedAt: new Date("2026-07-05T00:00:00.000Z"),
    });

    const actor = { companyId };
    const narrow = asAggregate(
      await kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "none" },
        actor,
      ),
    );
    expect(RECORD_VERIFICATION.mode).toBe("narrow");
    expect(narrow.orderCount).toBe(5);
    expect(narrow.grossByCurrency).toEqual([
      { currency: "UAH", grossAmountMinor: "1500" },
    ]);

    RECORD_VERIFICATION.mode = "strict";
    const strict = asAggregate(
      await kit.invoke(
        listOrders,
        { kind: "aggregate", groupBy: "none" },
        actor,
      ),
    );
    expect(strict.orderCount).toBe(4);
    expect(strict.grossByCurrency).toEqual([
      { currency: "UAH", grossAmountMinor: "1300" },
    ]);

    const page = asSummary(await kit.invoke(listOrders, pageSummary, actor));
    expect(page.items).toHaveLength(5);
    expect(page.items.map((row) => row.orderId).toSorted()).toEqual(
      [uiId, aiUnvouchedId, systemId, unknownId, aiVouchedId].toSorted(),
    );
  });
});
