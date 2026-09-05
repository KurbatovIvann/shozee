import { randomUUID } from "node:crypto";

import { ReferenceResolutionConflictError } from "@showzy/catalog";
import { CustomerReferenceConflictError } from "@showzy/customers";
import { defineActionContract } from "@showzy/core/contract";
import {
  defineEventHandler,
  eventEnvelopeSchema,
  implementAction,
} from "@showzy/core";
import {
  ConcurrentRetryError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  eventSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents, eventDeliveries } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import {
  companies,
  companyMembers,
  rolePermissionDefaults,
} from "@showzy/db/schema/companies";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { orderItems, orders } from "@showzy/db/schema/orders";
import {
  personalPrices,
  priceListEntries,
  priceLists,
} from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { cancelOrder } from "./cancel.js";
import { completeOrder } from "./complete.js";
import { confirmOrder } from "./confirm.js";
import { createOrder } from "./create.js";
import {
  CREATE_ORDER_MAX_ITEMS,
  DUPLICATE_ORDER_LINE_MESSAGE,
  VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
} from "./create.contract.js";
import { getOrder } from "./get.js";
import { listOrders } from "./list.js";
import { startOrder } from "./start.js";
import { ordersCreated } from "../events/created.js";
import { formatStaffOrderNumber } from "../services/order-number-format.js";

const TEST_CREATED_CONSUMER = "orders.test-created-noop";

const fixtures = {
  listCustomer: randomUUID(),
  listGroup: randomUUID(),
  listDefault: randomUUID(),
  groupA: randomUUID(),
  customerA: randomUUID(),
  customerBare: randomUUID(),
  customerB: randomUUID(),
  pPersonal: randomUUID(),
  pCustomerList: randomUUID(),
  pGroupList: randomUUID(),
  pDefault: randomUUID(),
  pBase: randomUUID(),
  pZero: randomUUID(),
  pVariant: randomUUID(),
  pEur: randomUUID(),
  pB: randomUUID(),
  vNamed: randomUUID(),
  personalPPersonal: randomUUID(),
  entryCustomerCustomerList: randomUUID(),
  entryGroupGroupList: randomUUID(),
  entryDefaultDefault: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderIdempotency: randomUUID(),
  orderIdempotencyConcurrent: randomUUID(),
  orderCanceled: randomUUID(),
  orderCancelIsolationA: randomUUID(),
  orderCancelIsolationB: randomUUID(),
  orderCancelIdempotency: randomUUID(),
  orderCancelIdempotencyConcurrent: randomUUID(),
  orderStartIsolationA: randomUUID(),
  orderStartIsolationB: randomUUID(),
  orderStartIdempotency: randomUUID(),
  orderStartIdempotencyConcurrent: randomUUID(),
  orderCompleteIsolationA: randomUUID(),
  orderCompleteIsolationB: randomUUID(),
  orderCompleteIdempotency: randomUUID(),
  orderCompleteIdempotencyConcurrent: randomUUID(),
  itemIsolationA: randomUUID(),
  itemIsolationB: randomUUID(),
  itemIdempotency: randomUUID(),
  itemIdempotencyConcurrent: randomUUID(),
  itemCanceled: randomUUID(),
  itemCancelIsolationA: randomUUID(),
  itemCancelIsolationB: randomUUID(),
  itemCancelIdempotency: randomUUID(),
  itemCancelIdempotencyConcurrent: randomUUID(),
  itemStartIsolationA: randomUUID(),
  itemStartIsolationB: randomUUID(),
  itemStartIdempotency: randomUUID(),
  itemStartIdempotencyConcurrent: randomUUID(),
  itemCompleteIsolationA: randomUUID(),
  itemCompleteIsolationB: randomUUID(),
  itemCompleteIdempotency: randomUUID(),
  itemCompleteIdempotencyConcurrent: randomUUID(),
  numberingA: randomUUID(),
  numberingB: randomUUID(),
  numberingCustomerA: randomUUID(),
  numberingCustomerB: randomUUID(),
  numberingProductA: randomUUID(),
  numberingProductB: randomUUID(),
  customerArchived: randomUUID(),
  customerTwinA: randomUUID(),
  customerTwinB: randomUUID(),
  pArchived: randomUUID(),
  pRetired: randomUUID(),
  vBlue: randomUUID(),
  vArchived: randomUUID(),
  vRetired: randomUUID(),
};

const clerks = {
  noCreate: randomUUID(),
  noEdit: randomUUID(),
  noView: randomUUID(),
  noProducts: randomUUID(),
  noPricing: randomUUID(),
  noCustomers: randomUUID(),
  employee: randomUUID(),
  noDocuments: randomUUID(),
};

let kit: TestKit;
const seedOrderNumbers = new Map<string, number>();

const emitCreatedThenFail = implementAction(
  defineActionContract({
    name: "orders.emitCreatedThenFail",
    description:
      "Test-local emitter that fails after buffering orders.created.",
    principal: "staff",
    transport: "internal",
    input: z.object({ orderId: z.uuid() }),
    output: z.object({ orderId: z.uuid() }),
    permissions: ["orders:create"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["orders.created"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(ordersCreated, {
        aggregate: { type: "order", id: input.orderId },
        payload: {
          orderId: input.orderId,
          customerId: fixtures.customerA,
          totalGrossMinor: "1",
          currency: "UAH",
          itemCount: 1,
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: (env) => {
      const input = env.input;
      const orderId =
        typeof input === "object" &&
        input !== null &&
        "orderId" in input &&
        typeof input.orderId === "string"
          ? input.orderId
          : "unknown";
      return { type: "order", id: orderId };
    },
  },
);

const projectCreatedTest = implementAction(
  defineActionContract({
    name: "orders.projectCreatedTest",
    description: "Test-local no-op consumer of orders.created.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(ordersCreated.payload),
    output: z.object({ ok: z.literal(true) }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => {
      return Promise.resolve({ ok: true as const });
    },
    auditTarget: () => ({ type: "order", id: "test-created-noop" }),
  },
);

const createdNoop = defineEventHandler({
  event: ordersCreated,
  consumer: TEST_CREATED_CONSUMER,
  action: projectCreatedTest,
});

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
  basePriceMinor: bigint;
  currency?: string;
  status?: "active" | "archived";
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: values.basePriceMinor,
    ...(values.currency === undefined ? {} : { currency: values.currency }),
    ...(values.status === undefined ? {} : { status: values.status }),
  });
}

async function expectConflict(
  run: Promise<unknown>,
  clientMessage: string,
): Promise<void> {
  const error = await run.then(
    () => {
      throw new Error("expected ConflictError");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConflictError);
  if (error instanceof ConflictError) {
    expect(error.clientMessage).toBe(clientMessage);
  }
}

function expectResolutionConflict(
  error: unknown,
): ReferenceResolutionConflictError {
  expect(error).toBeInstanceOf(ReferenceResolutionConflictError);
  expect(error).toBeInstanceOf(ConflictError);
  if (!(error instanceof ReferenceResolutionConflictError)) {
    throw new Error("expected ReferenceResolutionConflictError");
  }
  expect(error.code).toBe("CONFLICT");
  return error;
}

function expectCustomerConflict(
  error: unknown,
): CustomerReferenceConflictError {
  expect(error).toBeInstanceOf(CustomerReferenceConflictError);
  expect(error).toBeInstanceOf(ConflictError);
  if (!(error instanceof CustomerReferenceConflictError)) {
    throw new Error("expected CustomerReferenceConflictError");
  }
  expect(error.code).toBe("CONFLICT");
  expect(error.reason).toBe("ambiguous");
  return error;
}

function createById(
  customerId: string,
  items: readonly {
    readonly productId: string;
    readonly variantId?: string;
    readonly quantityMilli?: string;
  }[],
  comment?: string,
) {
  return {
    customer: { by: "id" as const, id: customerId },
    items: items.map((item) => ({
      product: { by: "id" as const, id: item.productId },
      ...(item.variantId === undefined
        ? {}
        : { variant: { by: "id" as const, id: item.variantId } }),
      quantity: { milli: item.quantityMilli ?? "1000" },
    })),
    ...(comment === undefined ? {} : { comment }),
  };
}

type PoolQueryClient = {
  query: (...args: never[]) => unknown;
};

type StatementPool = {
  on(
    event: "acquire",
    listener: (client: PoolQueryClient) => void,
  ): StatementPool;
};

const tappedPools = new WeakSet<object>();
const tappedClients = new WeakSet<object>();
let activeStatements: string[] | undefined;

function sqlTextFromQueryConfig(config: unknown): string | undefined {
  if (typeof config === "string") {
    return config;
  }
  if (typeof config !== "object" || config === null || !("text" in config)) {
    return undefined;
  }
  const text = config.text;
  return typeof text === "string" ? text : undefined;
}

function ensureStatementTap(pool: StatementPool): void {
  if (tappedPools.has(pool)) {
    return;
  }
  tappedPools.add(pool);
  pool.on("acquire", (client) => {
    if (tappedClients.has(client)) {
      return;
    }
    tappedClients.add(client);
    const originalQuery = client.query.bind(client);
    client.query = (...args: never[]) => {
      if (activeStatements !== undefined) {
        const text = sqlTextFromQueryConfig(args[0]);
        if (text !== undefined) {
          activeStatements.push(text);
        }
      }
      return originalQuery(...args);
    };
  });
}

async function collectStatements<T>(run: () => Promise<T>): Promise<{
  readonly outcome: PromiseSettledResult<T>;
  readonly statements: readonly string[];
}> {
  ensureStatementTap(kit.db.runtime.pool);
  const statements: string[] = [];
  activeStatements = statements;
  try {
    const value = await run();
    return { outcome: { status: "fulfilled", value }, statements };
  } catch (reason) {
    return { outcome: { status: "rejected", reason }, statements };
  } finally {
    activeStatements = undefined;
  }
}

function isPricingSql(sql: string): boolean {
  const normalized = sql.toLowerCase();
  return (
    normalized.includes("price_lists") ||
    normalized.includes("price_list_entries") ||
    normalized.includes("personal_prices")
  );
}

function isOrderWriteSql(sql: string): boolean {
  const normalized = sql.toLowerCase();
  return (
    /insert\s+into\s+"?orders"?/.test(normalized) ||
    /insert\s+into\s+"?order_items"?/.test(normalized) ||
    /insert\s+into\s+"?domain_events"?/.test(normalized)
  );
}

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

async function insertSeedOrder(values: {
  id: string;
  itemId: string;
  companyId: string;
  customerId: string;
  productId: string;
  status: "new" | "confirmed" | "in_progress" | "done" | "canceled";
}): Promise<void> {
  const needsConfirmedAt =
    values.status === "confirmed" ||
    values.status === "in_progress" ||
    values.status === "done";
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: nextSeedOrderNumber(values.companyId),
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: values.status,
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
    ...(needsConfirmedAt
      ? { confirmedAt: new Date("2026-01-15T12:00:00.000Z") }
      : {}),
  });
  await kit.db.runtime.db.insert(orderItems).values({
    id: values.itemId,
    companyId: values.companyId,
    orderId: values.id,
    productId: values.productId,
    titleSnapshot: "Seed",
    quantityMilli: 1000n,
    unitPriceMinor: 100n,
    taxTreatment: "exempt",
    netAmountMinor: 100n,
    grossAmountMinor: 100n,
    priceSource: "base",
    resolverVersion: 1,
  });
}

async function countCompanyOrders(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.companyId, companyId));
  return rows.length;
}

async function countCompanyOrderItems(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.companyId, companyId));
  return rows.length;
}

async function countCreatedEvents(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.companyId, companyId),
        eq(domainEvents.name, "orders.created"),
      ),
    );
  return rows.length;
}

async function countConfirmed(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.companyId, companyId), eq(orders.status, "confirmed")),
    );
  return rows.length;
}

async function countCanceled(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.companyId, companyId), eq(orders.status, "canceled")));
  return rows.length;
}

async function countInProgress(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.companyId, companyId), eq(orders.status, "in_progress")),
    );
  return rows.length;
}

async function countDone(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.companyId, companyId), eq(orders.status, "done")));
  return rows.length;
}

async function processedCreatedDeliveries(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ eventId: eventDeliveries.eventId })
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.consumer, TEST_CREATED_CONSUMER),
        eq(eventDeliveries.status, "processed"),
      ),
    );
  return rows.length;
}

const baseCreateInput = createById(fixtures.customerA, [
  { productId: fixtures.pBase },
]);

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(rolePermissionDefaults).values([
    { role: "employee", permission: "orders:create" },
    { role: "employee", permission: "orders:view" },
    { role: "employee", permission: "products:view" },
    { role: "employee", permission: "pricing:view" },
    { role: "employee", permission: "customers:view" },
    { role: "employee", permission: "documents:view" },
  ]);

  await kit.db.runtime.db.insert(priceLists).values([
    { id: fixtures.listCustomer, companyId: companyA, name: "Customer list" },
    { id: fixtures.listGroup, companyId: companyA, name: "Group list" },
    {
      id: fixtures.listDefault,
      companyId: companyA,
      isDefault: true,
      name: "Default",
    },
  ]);
  await kit.db.runtime.db.insert(customerGroups).values({
    id: fixtures.groupA,
    companyId: companyA,
    name: "Group A",
    slug: `group-${fixtures.groupA}`,
    priceListId: fixtures.listGroup,
  });
  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      email: `customer-${fixtures.customerA}@example.com`,
      groupId: fixtures.groupA,
      priceListId: fixtures.listCustomer,
    },
    {
      id: fixtures.customerBare,
      companyId: companyA,
      name: "Customer bare",
      email: `customer-${fixtures.customerBare}@example.com`,
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      email: `customer-${fixtures.customerB}@example.com`,
    },
    {
      id: fixtures.customerArchived,
      companyId: companyA,
      name: "Archived Buyer",
      phone: "+380501234567",
      status: "archived",
    },
    {
      id: fixtures.customerTwinA,
      companyId: companyA,
      name: "Twin Buyer",
      phone: "+380501112233",
      email: "twin-a@orders-kit.test",
    },
    {
      id: fixtures.customerTwinB,
      companyId: companyA,
      name: "Twin Buyer",
      phone: "+380504445566",
      email: "twin-b@orders-kit.test",
    },
  ]);

  await insertProduct({
    id: fixtures.pPersonal,
    companyId: companyA,
    name: "Personal",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pCustomerList,
    companyId: companyA,
    name: "Customer list",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pGroupList,
    companyId: companyA,
    name: "Group list",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pDefault,
    companyId: companyA,
    name: "Default list",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pBase,
    companyId: companyA,
    name: "Base",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pZero,
    companyId: companyA,
    name: "Zero",
    basePriceMinor: 0n,
  });
  await insertProduct({
    id: fixtures.pVariant,
    companyId: companyA,
    name: "Coat",
    basePriceMinor: 800n,
  });
  await insertProduct({
    id: fixtures.pEur,
    companyId: companyA,
    name: "Euro",
    basePriceMinor: 100n,
    currency: "EUR",
  });
  await insertProduct({
    id: fixtures.pB,
    companyId: companyB,
    name: "Foreign",
    basePriceMinor: 100n,
  });
  await insertProduct({
    id: fixtures.pArchived,
    companyId: companyA,
    name: "Archived Widget",
    basePriceMinor: 50n,
    status: "archived",
  });

  await insertProduct({
    id: fixtures.pRetired,
    companyId: companyA,
    name: "Retired Box",
    basePriceMinor: 20n,
  });

  await kit.db.runtime.db.insert(companies).values([
    {
      id: fixtures.numberingA,
      name: "Numbering A",
      slug: "orders-numbering-a-sho240",
      prefix: "N4",
    },
    {
      id: fixtures.numberingB,
      name: "Numbering B",
      slug: "orders-numbering-b-sho240",
      prefix: "N5",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: fixtures.numberingA,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: fixtures.numberingB,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
  ]);
  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.numberingCustomerA,
      companyId: fixtures.numberingA,
      name: "Numbering customer A",
      email: "numbering-a@orders-kit.test",
    },
    {
      id: fixtures.numberingCustomerB,
      companyId: fixtures.numberingB,
      name: "Numbering customer B",
      email: "numbering-b@orders-kit.test",
    },
  ]);
  await insertProduct({
    id: fixtures.numberingProductA,
    companyId: fixtures.numberingA,
    name: "Numbering cake A",
    basePriceMinor: 100n,
  });
  await insertProduct({
    id: fixtures.numberingProductB,
    companyId: fixtures.numberingB,
    name: "Numbering cake B",
    basePriceMinor: 100n,
  });
  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.vNamed,
      companyId: companyA,
      productId: fixtures.pVariant,
      name: "Red",
      basePriceMinor: 900n,
      currency: "UAH",
    },
    {
      id: fixtures.vBlue,
      companyId: companyA,
      productId: fixtures.pVariant,
      name: "Blue",
    },
    {
      id: fixtures.vArchived,
      companyId: companyA,
      productId: fixtures.pVariant,
      name: "Vintage",
      status: "archived",
    },
    {
      id: fixtures.vRetired,
      companyId: companyA,
      productId: fixtures.pRetired,
      name: "Old Pack",
      status: "archived",
    },
  ]);

  await kit.db.runtime.db.insert(personalPrices).values({
    id: fixtures.personalPPersonal,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pPersonal,
    priceMinor: 100n,
  });
  await kit.db.runtime.db.insert(priceListEntries).values([
    {
      id: fixtures.entryCustomerCustomerList,
      companyId: companyA,
      priceListId: fixtures.listCustomer,
      productId: fixtures.pCustomerList,
      priceMinor: 200n,
    },
    {
      id: fixtures.entryGroupGroupList,
      companyId: companyA,
      priceListId: fixtures.listGroup,
      productId: fixtures.pGroupList,
      priceMinor: 300n,
    },
    {
      id: fixtures.entryDefaultDefault,
      companyId: companyA,
      priceListId: fixtures.listDefault,
      productId: fixtures.pDefault,
      priceMinor: 400n,
    },
  ]);

  await insertSeedOrder({
    id: fixtures.orderIsolationA,
    itemId: fixtures.itemIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderIsolationB,
    itemId: fixtures.itemIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.pB,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderIdempotency,
    itemId: fixtures.itemIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderIdempotencyConcurrent,
    itemId: fixtures.itemIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderCanceled,
    itemId: fixtures.itemCanceled,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "canceled",
  });
  await insertSeedOrder({
    id: fixtures.orderCancelIsolationA,
    itemId: fixtures.itemCancelIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderCancelIsolationB,
    itemId: fixtures.itemCancelIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.pB,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderCancelIdempotency,
    itemId: fixtures.itemCancelIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderCancelIdempotencyConcurrent,
    itemId: fixtures.itemCancelIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderStartIsolationA,
    itemId: fixtures.itemStartIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "confirmed",
  });
  await insertSeedOrder({
    id: fixtures.orderStartIsolationB,
    itemId: fixtures.itemStartIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.pB,
    status: "confirmed",
  });
  await insertSeedOrder({
    id: fixtures.orderStartIdempotency,
    itemId: fixtures.itemStartIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "confirmed",
  });
  await insertSeedOrder({
    id: fixtures.orderStartIdempotencyConcurrent,
    itemId: fixtures.itemStartIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "confirmed",
  });
  await insertSeedOrder({
    id: fixtures.orderCompleteIsolationA,
    itemId: fixtures.itemCompleteIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "in_progress",
  });
  await insertSeedOrder({
    id: fixtures.orderCompleteIsolationB,
    itemId: fixtures.itemCompleteIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.pB,
    status: "in_progress",
  });
  await insertSeedOrder({
    id: fixtures.orderCompleteIdempotency,
    itemId: fixtures.itemCompleteIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "in_progress",
  });
  await insertSeedOrder({
    id: fixtures.orderCompleteIdempotencyConcurrent,
    itemId: fixtures.itemCompleteIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.pBase,
    status: "in_progress",
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noCreate,
      name: "No create",
      email: "nocreate@orders-kit.test",
    },
    { id: clerks.noEdit, name: "No edit", email: "noedit@orders-kit.test" },
    { id: clerks.noView, name: "No view", email: "noview@orders-kit.test" },
    {
      id: clerks.noProducts,
      name: "No products",
      email: "noproducts@orders-kit.test",
    },
    {
      id: clerks.noPricing,
      name: "No pricing",
      email: "nopricing@orders-kit.test",
    },
    {
      id: clerks.noCustomers,
      name: "No customers",
      email: "nocustomers@orders-kit.test",
    },
    {
      id: clerks.employee,
      name: "Employee clerk",
      email: "employee@orders-kit.test",
    },
    {
      id: clerks.noDocuments,
      name: "No documents view",
      email: "nodocuments@orders-kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerks.noCreate,
      role: "employee",
      permissions: { granted: [], denied: ["orders:create"] },
    },
    {
      companyId: companyA,
      userId: clerks.noEdit,
      role: "employee",
      permissions: { granted: [], denied: ["orders:edit"] },
    },
    {
      companyId: companyA,
      userId: clerks.noView,
      role: "employee",
      permissions: { granted: [], denied: ["orders:view"] },
    },
    {
      companyId: companyA,
      userId: clerks.noProducts,
      role: "employee",
      permissions: { granted: [], denied: ["products:view"] },
    },
    {
      companyId: companyA,
      userId: clerks.noPricing,
      role: "employee",
      permissions: { granted: [], denied: ["pricing:view"] },
    },
    {
      companyId: companyA,
      userId: clerks.noCustomers,
      role: "employee",
      permissions: { granted: [], denied: ["customers:view"] },
    },
    {
      companyId: fixtures.numberingA,
      userId: clerks.employee,
      role: "employee",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: fixtures.numberingA,
      userId: clerks.noDocuments,
      role: "employee",
      permissions: { granted: [], denied: ["documents:view"] },
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
      createOrder,
      { input: baseCreateInput },
      {
        input: createById(fixtures.customerB, [{ productId: fixtures.pB }]),
      },
    ),
    isolationCase(
      createOrder,
      {
        input: {
          customer: { by: "id" as const, id: fixtures.customerA },
          items: [
            {
              product: { by: "id" as const, id: fixtures.pVariant },
              variantSelection: {
                kind: "reference" as const,
                ref: { by: "id" as const, id: fixtures.vNamed },
              },
              quantity: { milli: "1000" },
            },
          ],
        },
      },
      {
        input: createById(fixtures.customerB, [{ productId: fixtures.pB }]),
      },
    ),
    isolationCase(
      confirmOrder,
      { input: { orderId: fixtures.orderIsolationA } },
      { input: { orderId: fixtures.orderIsolationB } },
    ),
    isolationCase(
      startOrder,
      { input: { orderId: fixtures.orderStartIsolationA } },
      { input: { orderId: fixtures.orderStartIsolationB } },
    ),
    isolationCase(
      completeOrder,
      { input: { orderId: fixtures.orderCompleteIsolationA } },
      { input: { orderId: fixtures.orderCompleteIsolationB } },
    ),
    isolationCase(
      cancelOrder,
      { input: { orderId: fixtures.orderCancelIsolationA } },
      { input: { orderId: fixtures.orderCancelIsolationB } },
    ),
    isolationCase(
      getOrder,
      { input: { orderId: fixtures.orderIsolationA } },
      { input: { orderId: fixtures.orderIsolationB } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createOrder,
      input: baseCreateInput,
      conflictingInput: createById(fixtures.customerA, [
        { productId: fixtures.pZero },
      ]),
      readEffect: () => countCompanyOrders(kitIdentities.companies.a),
    },
    {
      action: createOrder,
      input: {
        customer: { by: "id" as const, id: fixtures.customerA },
        items: [
          {
            product: { by: "id" as const, id: fixtures.pZero },
            variantSelection: { kind: "base" as const },
            quantity: { milli: "1000" },
          },
        ],
      },
      conflictingInput: createById(fixtures.customerA, [
        { productId: fixtures.pBase },
      ]),
      readEffect: () => countCompanyOrders(kitIdentities.companies.a),
    },
    {
      action: confirmOrder,
      input: { orderId: fixtures.orderIdempotency },
      conflictingInput: { orderId: fixtures.orderCanceled },
      freshInput: () => ({ orderId: fixtures.orderIdempotencyConcurrent }),
      readEffect: () => countConfirmed(kitIdentities.companies.a),
    },
    {
      action: startOrder,
      input: { orderId: fixtures.orderStartIdempotency },
      conflictingInput: { orderId: fixtures.orderCanceled },
      freshInput: () => ({ orderId: fixtures.orderStartIdempotencyConcurrent }),
      readEffect: () => countInProgress(kitIdentities.companies.a),
    },
    {
      action: completeOrder,
      input: { orderId: fixtures.orderCompleteIdempotency },
      conflictingInput: { orderId: fixtures.orderCanceled },
      freshInput: () => ({
        orderId: fixtures.orderCompleteIdempotencyConcurrent,
      }),
      readEffect: () => countDone(kitIdentities.companies.a),
    },
    {
      action: cancelOrder,
      input: { orderId: fixtures.orderCancelIdempotency },
      conflictingInput: { orderId: fixtures.orderCanceled },
      freshInput: () => ({
        orderId: fixtures.orderCancelIdempotencyConcurrent,
      }),
      readEffect: () => countCanceled(kitIdentities.companies.a),
    },
  ],
);

eventSuite(() => kit, {
  module: "orders",
  emitAction: createOrder,
  emitInput: createById(fixtures.customerA, [
    { productId: fixtures.pZero, quantityMilli: "2000" },
  ]),
  failingEmitAction: emitCreatedThenFail,
  failingEmitInput: { orderId: randomUUID() },
  eventName: "orders.created",
  subscription: createdNoop,
  readProjection: processedCreatedDeliveries,
});

describe("orders.create / confirm / get", () => {
  it("snapshots five-level provenance, titles, money identity, then confirm and get", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(
        fixtures.customerA,
        [
          { productId: fixtures.pPersonal },
          { productId: fixtures.pCustomerList },
          { productId: fixtures.pGroupList },
          { productId: fixtures.pDefault },
          { productId: fixtures.pBase },
          {
            productId: fixtures.pVariant,
            variantId: fixtures.vNamed,
            quantityMilli: "500",
          },
        ],
        "Staff note",
      ),
    );

    expect(created.status).toBe("new");
    expect(created.orderNumber).toMatch(/^KA-[0-9A-Z]+$/);
    expect(created.itemCount).toBe(6);
    expect(created.customer.linkedCustomerId).toBe(fixtures.customerA);
    expect(created.customer.nameSnapshot).toBe("Customer A");
    expect(Object.prototype.hasOwnProperty.call(created, "items")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(created, "comment")).toBe(
      false,
    );

    const snapshot = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(snapshot.comment).toBe("Staff note");
    expect(snapshot.customerId).toBe(fixtures.customerA);
    expect(snapshot.items).toHaveLength(6);

    const [header] = await kit.db.runtime.db
      .select({ snapshot: orders.customerNameSnapshot })
      .from(orders)
      .where(eq(orders.id, created.orderId));
    expect(header?.snapshot).toBe("Customer A");

    const byProduct = new Map(
      snapshot.items.map((item) => [item.productId, item]),
    );
    expect(byProduct.get(fixtures.pPersonal)).toMatchObject({
      titleSnapshot: "Personal",
      unitPriceMinor: "100",
      priceSource: "personal",
      personalPriceId: fixtures.personalPPersonal,
      resolverVersion: 1,
      taxTreatment: "exempt",
      discountKind: "none",
      netAmountMinor: "100",
      grossAmountMinor: "100",
      taxAmountMinor: "0",
    });
    expect(byProduct.get(fixtures.pCustomerList)).toMatchObject({
      unitPriceMinor: "200",
      priceSource: "customer_price_list",
      priceListId: fixtures.listCustomer,
      priceListEntryId: fixtures.entryCustomerCustomerList,
    });
    expect(byProduct.get(fixtures.pGroupList)).toMatchObject({
      unitPriceMinor: "300",
      priceSource: "group_price_list",
      priceListId: fixtures.listGroup,
      priceListEntryId: fixtures.entryGroupGroupList,
    });
    expect(byProduct.get(fixtures.pDefault)).toMatchObject({
      unitPriceMinor: "400",
      priceSource: "default_price_list",
      priceListId: fixtures.listDefault,
      priceListEntryId: fixtures.entryDefaultDefault,
    });
    expect(byProduct.get(fixtures.pBase)).toMatchObject({
      unitPriceMinor: "500",
      priceSource: "base",
    });
    expect(byProduct.get(fixtures.pVariant)).toMatchObject({
      titleSnapshot: "Coat · Red",
      variantId: fixtures.vNamed,
      unitPriceMinor: "900",
      quantityMilli: "500",
      netAmountMinor: "450",
      grossAmountMinor: "450",
    });

    const lineNet = snapshot.items.reduce(
      (sum, item) => sum + BigInt(item.netAmountMinor),
      0n,
    );
    const lineTax = snapshot.items.reduce(
      (sum, item) => sum + BigInt(item.taxAmountMinor),
      0n,
    );
    const lineGross = snapshot.items.reduce(
      (sum, item) => sum + BigInt(item.grossAmountMinor),
      0n,
    );
    expect(lineNet + lineTax).toBe(lineGross);
    expect(created.totalNetMinor).toBe(lineNet.toString(10));
    expect(created.totalTaxMinor).toBe(lineTax.toString(10));
    expect(created.totalGrossMinor).toBe(lineGross.toString(10));

    const dbLines = await kit.db.runtime.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, created.orderId));
    expect(dbLines).toHaveLength(6);
    for (const row of dbLines) {
      expect(row.netAmountMinor + row.taxAmountMinor).toBe(
        row.grossAmountMinor,
      );
    }

    const createdEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(createdEvents.map((row) => row.name)).toContain("orders.created");
    const createdEvent = createdEvents.find(
      (row) => row.name === "orders.created",
    );
    expect(createdEvent?.payload).toMatchObject({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      totalGrossMinor: created.totalGrossMinor,
      currency: "UAH",
      itemCount: 6,
    });
    expect(createdEvent?.payload).not.toHaveProperty("comment");

    const createAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "orders.create"));
    const thisCreate = createAudit.filter(
      (row) => row.targetId === created.orderId,
    );
    expect(thisCreate.length).toBeGreaterThanOrEqual(1);
    expect(thisCreate[0]?.inputSnapshot).toBeNull();
    expect(thisCreate[0]?.targetType).toBe("order");
    expect(JSON.stringify(thisCreate[0]?.inputSnapshot)).not.toContain(
      "Staff note",
    );

    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.customerId).toBe(fixtures.customerA);
    expect(confirmed.confirmedAt).toEqual(expect.any(String));

    const confirmEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(confirmEvents.map((row) => row.name)).toContain("orders.confirmed");

    const confirmAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "orders.confirm"),
          eq(auditLog.targetId, created.orderId),
        ),
      );
    expect(confirmAudit.length).toBeGreaterThanOrEqual(1);
    expect(confirmAudit[0]?.inputSnapshot).toBeNull();

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("confirmed");
    expect(fetched.orderNumber).toBe(created.orderNumber);
    expect(fetched.comment).toBe("Staff note");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
    expect(fetched.totalGrossMinor).toBe(created.totalGrossMinor);
    expect(fetched.items).toHaveLength(6);
    expect(fetched.items.map((item) => item.unitPriceMinor).sort()).toEqual(
      snapshot.items.map((item) => item.unitPriceMinor).sort(),
    );
  });

  it("keeps snapshots after a later catalog price change", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [{ productId: fixtures.pBase }]),
    );
    const beforeChange = await kit.invoke(getOrder, {
      orderId: created.orderId,
    });
    expect(beforeChange.items[0]?.unitPriceMinor).toBe("500");

    await kit.db.runtime.db
      .update(products)
      .set({ basePriceMinor: 9999n })
      .where(eq(products.id, fixtures.pBase));

    try {
      const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
      expect(fetched.items[0]?.unitPriceMinor).toBe("500");
      expect(fetched.totalGrossMinor).toBe(created.totalGrossMinor);
    } finally {
      await kit.db.runtime.db
        .update(products)
        .set({ basePriceMinor: 500n })
        .where(eq(products.id, fixtures.pBase));
    }
  });

  it("rejects mixed currencies", async () => {
    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerBare, [
          { productId: fixtures.pBase, quantityMilli: "1000" },
          { productId: fixtures.pEur, quantityMilli: "1000" },
        ]),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("assigns per-company {prefix}-{token} numbers via companies.get and returns them on get/list", async () => {
    const actorA = { companyId: fixtures.numberingA };
    const actorB = { companyId: fixtures.numberingB };
    const firstA = await kit.invoke(
      createOrder,
      createById(fixtures.numberingCustomerA, [
        { productId: fixtures.numberingProductA, quantityMilli: "1000" },
      ]),
      actorA,
    );
    const firstB = await kit.invoke(
      createOrder,
      createById(fixtures.numberingCustomerB, [
        { productId: fixtures.numberingProductB, quantityMilli: "1000" },
      ]),
      actorB,
    );
    expect(firstA.orderNumber).toBe(formatStaffOrderNumber("N4", 1n));
    expect(firstB.orderNumber).toBe(formatStaffOrderNumber("N5", 1n));
    expect(firstA.orderNumber).not.toBe(firstB.orderNumber);

    const secondA = await kit.invoke(
      createOrder,
      createById(fixtures.numberingCustomerA, [
        { productId: fixtures.numberingProductA, quantityMilli: "1000" },
      ]),
      actorA,
    );
    expect(secondA.orderNumber).toBe(formatStaffOrderNumber("N4", 2n));

    const fetched = await kit.invoke(
      getOrder,
      { orderId: firstA.orderId },
      actorA,
    );
    expect(fetched.orderNumber).toBe(formatStaffOrderNumber("N4", 1n));

    const listed = await kit.invoke(
      listOrders,
      { kind: "page.summary" },
      actorA,
    );
    expect(listed.kind).toBe("page.summary");
    if (listed.kind !== "page.summary") {
      throw new Error("expected page.summary");
    }
    expect(listed.items.map((row) => row.orderNumber).toSorted()).toEqual(
      [
        formatStaffOrderNumber("N4", 1n),
        formatStaffOrderNumber("N4", 2n),
      ].toSorted(),
    );
  });

  it("lets an employee without settings:payments create a numbered order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.numberingCustomerA, [
        { productId: fixtures.numberingProductA, quantityMilli: "1000" },
      ]),
      { userId: clerks.employee, companyId: fixtures.numberingA },
    );
    expect(created.orderNumber.startsWith("N4-")).toBe(true);
    expect(created.orderNumber).toMatch(/^N4-[0-9A-Z]+$/);
    expect(created.orderNumber).not.toBe("1");
  });

  it("denies create numbering when the staff caller lacks documents:view", async () => {
    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.numberingCustomerA, [
          { productId: fixtures.numberingProductA, quantityMilli: "1000" },
        ]),
        { userId: clerks.noDocuments, companyId: fixtures.numberingA },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("does not collide concurrent creates on the same company counter", async () => {
    const actor = { companyId: fixtures.numberingA };
    const [left, right] = await Promise.all([
      kit.invoke(
        createOrder,
        createById(fixtures.numberingCustomerA, [
          { productId: fixtures.numberingProductA, quantityMilli: "1000" },
        ]),
        actor,
      ),
      kit.invoke(
        createOrder,
        createById(fixtures.numberingCustomerA, [
          { productId: fixtures.numberingProductA, quantityMilli: "1000" },
        ]),
        actor,
      ),
    ]);
    const numbers = [left.orderNumber, right.orderNumber].toSorted();
    expect(new Set(numbers).size).toBe(2);
    expect(left.orderId).not.toBe(right.orderId);
    expect(numbers.every((value) => value.startsWith("N4-"))).toBe(true);
  });

  it("denies missing orders permissions and nested view permissions", async () => {
    const actorCompany = { companyId: kitIdentities.companies.a };
    await expect(
      kit.invoke(createOrder, baseCreateInput, {
        ...actorCompany,
        userId: clerks.noCreate,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        confirmOrder,
        { orderId: fixtures.orderCanceled },
        { ...actorCompany, userId: clerks.noEdit },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        getOrder,
        { orderId: fixtures.orderIsolationA },
        { ...actorCompany, userId: clerks.noView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(createOrder, baseCreateInput, {
        ...actorCompany,
        userId: clerks.noProducts,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(createOrder, baseCreateInput, {
        ...actorCompany,
        userId: clerks.noPricing,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(createOrder, baseCreateInput, {
        ...actorCompany,
        userId: clerks.noCustomers,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects empty, duplicate, oversized, and malformed lines", async () => {
    await expect(
      kit.invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerA },
        items: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerA, [
          { productId: fixtures.pBase, quantityMilli: "1000" },
          { productId: fixtures.pBase, quantityMilli: "2000" },
        ]),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversized = Array.from(
      { length: CREATE_ORDER_MAX_ITEMS + 1 },
      () => ({
        product: { by: "id" as const, id: randomUUID() },
        quantity: { milli: "1000" },
      }),
    );
    await expect(
      kit.invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerA },
        items: oversized,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    for (const milli of ["0", "-1", "01", "1.5"]) {
      await expect(
        kit.invoke(createOrder, {
          customer: { by: "id", id: fixtures.customerA },
          items: [
            {
              product: { by: "id", id: fixtures.pBase },
              quantity: { milli },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    await expect(
      kit.invoke(
        createOrder,
        createById(
          fixtures.customerA,
          [{ productId: fixtures.pBase }],
          "x".repeat(2001),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a missing idempotency key on create and confirm", async () => {
    await expect(
      kit.invoke(
        createOrder,
        baseCreateInput,
        {},
        {
          request: { idempotencyKey: "" },
        },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(
        confirmOrder,
        { orderId: fixtures.orderCanceled },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns NotFound for foreign or missing customers, products, and orders", async () => {
    const missing = randomUUID();
    const missingCustomer = await kit
      .invoke(
        createOrder,
        createById(missing, [
          { productId: fixtures.pBase, quantityMilli: "1000" },
        ]),
      )
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignCustomer = await kit
      .invoke(
        createOrder,
        createById(fixtures.customerB, [
          { productId: fixtures.pBase, quantityMilli: "1000" },
        ]),
      )
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingCustomer).toBeInstanceOf(NotFoundError);
    expect(foreignCustomer).toBeInstanceOf(NotFoundError);
    if (
      missingCustomer instanceof NotFoundError &&
      foreignCustomer instanceof NotFoundError
    ) {
      expect(missingCustomer.clientMessage).toBe(foreignCustomer.clientMessage);
    }

    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerA, [
          { productId: missing, quantityMilli: "1000" },
        ]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerA, [
          { productId: fixtures.pB, quantityMilli: "1000" },
        ]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const missingOrder = await kit.invoke(getOrder, { orderId: missing }).then(
      () => {
        throw new Error("expected NotFoundError");
      },
      (error: unknown) => error,
    );
    const foreignOrder = await kit
      .invoke(getOrder, { orderId: fixtures.orderIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingOrder).toBeInstanceOf(NotFoundError);
    expect(foreignOrder).toBeInstanceOf(NotFoundError);
    if (
      missingOrder instanceof NotFoundError &&
      foreignOrder instanceof NotFoundError
    ) {
      expect(missingOrder.clientMessage).toBe(foreignOrder.clientMessage);
    }
  });

  it("conflicts when confirming a non-new order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await expect(
      kit.invoke(confirmOrder, { orderId: created.orderId }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      kit.invoke(confirmOrder, { orderId: fixtures.orderCanceled }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("serializes concurrent confirms of the same new order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "3000" },
      ]),
    );
    const results = await Promise.allSettled([
      kit.invoke(confirmOrder, { orderId: created.orderId }),
      kit.invoke(confirmOrder, { orderId: created.orderId }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0];
    expect(reason?.status).toBe("rejected");
    if (reason?.status === "rejected") {
      expect(
        reason.reason instanceof ConflictError ||
          reason.reason instanceof ConcurrentRetryError,
      ).toBe(true);
    }
    const row = await kit.db.runtime.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, created.orderId));
    expect(row[0]?.status).toBe("confirmed");
  });
});

describe("orders.create reference resolve (SHO-352)", () => {
  it("id-path and unique query-path create the same compact summary", async () => {
    const byId = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [{ productId: fixtures.pZero }]),
    );
    const byQuery = await kit.invoke(createOrder, {
      customer: { by: "query", value: "  Customer   A " },
      items: [
        {
          product: { by: "query", value: "Zero" },
          quantity: { decimal: "1" },
        },
      ],
    });
    expect(byId.customer).toEqual({
      nameSnapshot: "Customer A",
      linkedCustomerId: fixtures.customerA,
    });
    expect(byQuery.customer).toEqual(byId.customer);
    expect(byId.itemCount).toBe(1);
    expect(byQuery.itemCount).toBe(1);
    expect(byId.status).toBe("new");
    expect(Object.prototype.hasOwnProperty.call(byId, "items")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(byId, "comment")).toBe(false);

    const snapshot = await kit.invoke(getOrder, { orderId: byQuery.orderId });
    expect(snapshot.items[0]?.quantityMilli).toBe("1000");
    expect(snapshot.customerId).toBe(fixtures.customerA);
  });

  it("eval 3: unique customer and product names issue one orders.create", async () => {
    const before = await countCompanyOrders(kitIdentities.companies.a);
    const created = await kit.invoke(createOrder, {
      customer: { by: "query", value: "Customer A" },
      items: [
        {
          product: { by: "query", value: "Zero" },
          quantity: { decimal: "2" },
        },
      ],
    });
    expect(created.orderId).toEqual(expect.any(String));
    expect(created.customer.linkedCustomerId).toBe(fixtures.customerA);
    const after = await countCompanyOrders(kitIdentities.companies.a);
    expect(after).toBe(before + 1);
    const snapshot = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(snapshot.items[0]?.quantityMilli).toBe("2000");
  });

  it("creates from unique query names when contains scans are capped", async () => {
    const customerName = "ZzzExactBuyer";
    const customerId = randomUUID();
    const productName = "ZzzExactWidget";
    const productId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: customerId,
      companyId: kitIdentities.companies.a,
      name: customerName,
      email: `exact-buyer-${customerId}@orders-kit.test`,
      status: "active",
    });
    await insertProduct({
      id: productId,
      companyId: kitIdentities.companies.a,
      name: productName,
      basePriceMinor: 10n,
    });
    await kit.db.runtime.db.insert(companyCustomers).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `Aaa${customerName} ${String(index).padStart(3, "0")}`,
        email: `flood-buyer-${String(index)}-${customerId}@orders-kit.test`,
        status: "active" as const,
      })),
    );
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `Aaa${productName} ${String(index).padStart(3, "0")}`,
        basePriceMinor: 10n,
        status: "active" as const,
      })),
    );

    const before = await countCompanyOrders(kitIdentities.companies.a);
    const created = await kit.invoke(createOrder, {
      customer: { by: "query", value: customerName },
      items: [
        {
          product: { by: "query", value: productName },
          quantity: { milli: "1000" },
        },
      ],
    });
    expect(created.customer.linkedCustomerId).toBe(customerId);
    expect(created.itemCount).toBe(1);
    expect(await countCompanyOrders(kitIdentities.companies.a)).toBe(
      before + 1,
    );
    const snapshot = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(snapshot.customerId).toBe(customerId);
    expect(snapshot.items[0]?.productId).toBe(productId);
  });

  it("eval 4: ambiguous name is CONFLICT and does not write", async () => {
    const before = await countCompanyOrders(kitIdentities.companies.a);
    const eventsBefore = await countCreatedEvents(kitIdentities.companies.a);
    const error = await kit
      .invoke(createOrder, {
        customer: { by: "query", value: "Twin Buyer" },
        items: [
          {
            product: { by: "query", value: "Zero" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectCustomerConflict(error);
    expect(conflict.target).toEqual({
      kind: "customer",
      query: "Twin Buyer",
    });
    expect(conflict.options.map((option) => option.id).toSorted()).toEqual(
      [fixtures.customerTwinA, fixtures.customerTwinB].toSorted(),
    );
    expect(conflict.options.map((option) => option.label).toSorted()).toEqual([
      "Twin Buyer (…2233)",
      "Twin Buyer (…5566)",
    ]);
    expect(conflict.clientMessage).toBe(
      'Select a customer matching "Twin Buyer".',
    );
    expect(conflict.clientMessage).not.toContain("Multiple matches");
    expect(await countCompanyOrders(kitIdentities.companies.a)).toBe(before);
    expect(await countCreatedEvents(kitIdentities.companies.a)).toBe(
      eventsBefore,
    );
  });

  it("conflicts on zero/ambiguous product refs with structured product options", async () => {
    await expect(
      kit.invoke(createOrder, {
        customer: { by: "query", value: "Nobody Here" },
        items: [
          {
            product: { by: "query", value: "Zero" },
            quantity: { milli: "1000" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const productError = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerA },
        items: [
          {
            product: { by: "query", value: "list" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const productConflict = expectResolutionConflict(productError);
    expect(productConflict.reason).toBe("ambiguous");
    expect(productConflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "list",
    });
    expect(productConflict.options.length).toBeGreaterThan(1);
    expect(productConflict.clientMessage).toBe(
      'Select a product matching "list".',
    );
    expect(productConflict.clientMessage).not.toContain("Multiple matches");

    await kit.db.runtime.db.insert(companyCustomers).values(
      Array.from({ length: 6 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `CapLabel ${String(index)}`,
        email: `caplabel-${String(index)}@orders-kit.test`,
        status: "active" as const,
      })),
    );
    const error = await kit
      .invoke(createOrder, {
        customer: { by: "query", value: "CapLabel" },
        items: [
          {
            product: { by: "query", value: "Zero" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected CustomerReferenceConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectCustomerConflict(error);
    expect(conflict.options).toHaveLength(6);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.clientMessage).not.toContain("Multiple matches");
  });

  it("rejects duplicate product/variant after canonical resolve", async () => {
    const error = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerA },
        items: [
          {
            product: { by: "query", value: "Base" },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: fixtures.pBase },
            quantity: { milli: "2000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ValidationError");
        },
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ValidationError);
    if (!(error instanceof ValidationError)) {
      return;
    }
    expect(error.clientMessage).toBe(DUPLICATE_ORDER_LINE_MESSAGE);
  });

  it("lets id-path target archived CRM rows, rejects archived catalog ids, and conflicts on archived catalog names", async () => {
    const archivedCustomer = await kit.invoke(
      createOrder,
      createById(fixtures.customerArchived, [{ productId: fixtures.pZero }]),
    );
    expect(archivedCustomer.customer.linkedCustomerId).toBe(
      fixtures.customerArchived,
    );
    expect(archivedCustomer.customer.nameSnapshot).toBe("Archived Buyer");
    await expect(
      kit.invoke(createOrder, {
        customer: { by: "query", value: "Archived Buyer" },
        items: [
          {
            product: { by: "query", value: "Zero" },
            quantity: { milli: "1000" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerBare, [{ productId: fixtures.pArchived }]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const ordersBefore = await countCompanyOrders(kitIdentities.companies.a);
    const eventsBefore = await countCreatedEvents(kitIdentities.companies.a);
    const archivedNameError = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "query", value: "Archived Widget" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const archivedNameConflict = expectResolutionConflict(archivedNameError);
    expect(archivedNameConflict.reason).toBe("archived");
    expect(archivedNameConflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "Archived Widget",
      productName: "Archived Widget",
    });
    expect(archivedNameConflict.options).toEqual([]);
    expect(archivedNameConflict.optionsTruncated).toBe(false);
    expect(archivedNameConflict.clientMessage).toBe(
      '"Archived Widget" is archived.',
    );
    expect(await countCompanyOrders(kitIdentities.companies.a)).toBe(
      ordersBefore,
    );
    expect(await countCreatedEvents(kitIdentities.companies.a)).toBe(
      eventsBefore,
    );
  });

  it("hard-stops a mixed cart on an archived query before a variant picker or write", async () => {
    const companyId = kitIdentities.companies.a;
    const ordersBefore = await countCompanyOrders(companyId);
    const itemsBefore = await countCompanyOrderItems(companyId);
    const eventsBefore = await countCreatedEvents(companyId);
    const { outcome, statements } = await collectStatements(() =>
      kit.invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "query", value: "Coat" },
            quantity: { milli: "3000" },
          },
          {
            product: { by: "query", value: "Archived Widget" },
            quantity: { milli: "1000" },
          },
        ],
      }),
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    const conflict = expectResolutionConflict(outcome.reason);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 1,
      query: "Archived Widget",
      productName: "Archived Widget",
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.reason).not.toBe("variant_required");
    expect(await countCompanyOrders(companyId)).toBe(ordersBefore);
    expect(await countCompanyOrderItems(companyId)).toBe(itemsBefore);
    expect(await countCreatedEvents(companyId)).toBe(eventsBefore);
    expect(statements.some((sql) => isPricingSql(sql))).toBe(false);
    expect(statements.some((sql) => isOrderWriteSql(sql))).toBe(false);
  });

  it("audits and emits orders.created on the resolved canonical customer id", async () => {
    const created = await kit.invoke(createOrder, {
      customer: { by: "query", value: "Customer A" },
      items: [
        {
          product: { by: "query", value: "Zero" },
          quantity: { milli: "1000" },
        },
      ],
    });
    const createdEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    const createdEvent = createdEvents.find(
      (row) => row.name === "orders.created",
    );
    expect(createdEvent?.payload).toMatchObject({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      itemCount: 1,
    });
    const createAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "orders.create"),
          eq(auditLog.targetId, created.orderId),
        ),
      );
    expect(createAudit[0]?.targetId).toBe(created.orderId);
    expect(createAudit[0]?.targetType).toBe("order");
  });
});

describe("orders.create variantSelection (SHO-406)", () => {
  it("creates a zero-variant simple product with omit, unspecified, or base as variantId null", async () => {
    const omitted = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [{ productId: fixtures.pBase }]),
    );
    const unspecified = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pBase },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    });
    const base = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pBase },
          variantSelection: { kind: "base" },
          quantity: { milli: "1000" },
        },
      ],
    });
    for (const created of [omitted, unspecified, base]) {
      const snapshot = await kit.invoke(getOrder, { orderId: created.orderId });
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]?.productId).toBe(fixtures.pBase);
      expect(snapshot.items[0]?.variantId).toBeNull();
    }
  });

  it("creates the same canonical line from legacy variant and variantSelection.reference", async () => {
    const legacy = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pVariant, variantId: fixtures.vNamed },
      ]),
    );
    const selection = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pVariant },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.vNamed },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    const legacySnapshot = await kit.invoke(getOrder, {
      orderId: legacy.orderId,
    });
    const selectionSnapshot = await kit.invoke(getOrder, {
      orderId: selection.orderId,
    });
    expect(legacySnapshot.items[0]?.productId).toBe(fixtures.pVariant);
    expect(legacySnapshot.items[0]?.variantId).toBe(fixtures.vNamed);
    expect(selectionSnapshot.items[0]?.productId).toBe(
      legacySnapshot.items[0]?.productId,
    );
    expect(selectionSnapshot.items[0]?.variantId).toBe(
      legacySnapshot.items[0]?.variantId,
    );
    expect(legacySnapshot.items[0]?.titleSnapshot).toBe("Coat · Red");
    expect(selectionSnapshot.items[0]?.titleSnapshot).toBe("Coat · Red");
  });

  it("rejects variant and variantSelection together and still rejects canonical duplicates after resolve", async () => {
    const exclusive = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "id", id: fixtures.pVariant },
            variant: { by: "id", id: fixtures.vNamed },
            variantSelection: {
              kind: "reference",
              ref: { by: "id", id: fixtures.vNamed },
            },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ValidationError");
        },
        (caught: unknown) => caught,
      );
    expect(exclusive).toBeInstanceOf(ValidationError);
    if (!(exclusive instanceof ValidationError)) {
      return;
    }
    expect(exclusive.clientMessage).toBe("Input validation failed.");
    expect(JSON.stringify(exclusive.issues)).toContain(
      VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
    );

    const duplicate = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "id", id: fixtures.pVariant },
            variant: { by: "id", id: fixtures.vNamed },
            quantity: { milli: "1000" },
          },
          {
            product: { by: "id", id: fixtures.pVariant },
            variantSelection: {
              kind: "reference",
              ref: { by: "id", id: fixtures.vNamed },
            },
            quantity: { milli: "2000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ValidationError");
        },
        (caught: unknown) => caught,
      );
    expect(duplicate).toBeInstanceOf(ValidationError);
    if (!(duplicate instanceof ValidationError)) {
      return;
    }
    expect(duplicate.clientMessage).toBe(DUPLICATE_ORDER_LINE_MESSAGE);
  });

  it("creates from a unique active variant reference by id and by query", async () => {
    const byId = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pVariant },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.vNamed },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    const byQuery = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "query", value: "Coat" },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Red" },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    const idSnapshot = await kit.invoke(getOrder, { orderId: byId.orderId });
    const querySnapshot = await kit.invoke(getOrder, {
      orderId: byQuery.orderId,
    });
    expect(idSnapshot.items[0]?.productId).toBe(fixtures.pVariant);
    expect(idSnapshot.items[0]?.variantId).toBe(fixtures.vNamed);
    expect(querySnapshot.items[0]?.productId).toBe(fixtures.pVariant);
    expect(querySnapshot.items[0]?.variantId).toBe(fixtures.vNamed);
  });

  it("creates two distinct variants of one product when each line names a different selection", async () => {
    const created = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pVariant },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.vNamed },
          },
          quantity: { milli: "1000" },
        },
        {
          product: { by: "id", id: fixtures.pVariant },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.vBlue },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    const snapshot = await kit.invoke(getOrder, { orderId: created.orderId });
    const variantIds = snapshot.items.map((item) => item.variantId);
    expect(variantIds).toEqual(
      expect.arrayContaining([fixtures.vBlue, fixtures.vNamed]),
    );
    expect(variantIds).toHaveLength(2);
  });

  it("conflicts on variable parent omit or base without writing a row", async () => {
    const before = await countCompanyOrders(kitIdentities.companies.a);
    const eventsBefore = await countCreatedEvents(kitIdentities.companies.a);
    const omitted = await kit
      .invoke(
        createOrder,
        createById(fixtures.customerBare, [{ productId: fixtures.pVariant }]),
      )
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const base = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "id", id: fixtures.pVariant },
            variantSelection: { kind: "base" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    for (const error of [omitted, base]) {
      const conflict = expectResolutionConflict(error);
      expect(conflict.reason).toBe("variant_required");
      expect(conflict.target).toEqual({
        kind: "order_line_variant",
        lineIndex: 0,
        productId: fixtures.pVariant,
        productName: "Coat",
      });
      expect(conflict.options).toEqual([
        { id: fixtures.vBlue, label: "Blue" },
        { id: fixtures.vNamed, label: "Red" },
      ]);
      expect(conflict.optionsTruncated).toBe(false);
      expect(conflict.options.map((option) => option.id)).not.toContain(
        fixtures.vArchived,
      );
    }
    expect(await countCompanyOrders(kitIdentities.companies.a)).toBe(before);
    expect(await countCreatedEvents(kitIdentities.companies.a)).toBe(
      eventsBefore,
    );
  });

  it("returns no_active_variants for archived-only variable products and does not sell the parent", async () => {
    const before = await countCompanyOrders(kitIdentities.companies.a);
    const unspecified = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "id", id: fixtures.pRetired },
            variantSelection: { kind: "unspecified" },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const omitted = await kit
      .invoke(
        createOrder,
        createById(fixtures.customerBare, [{ productId: fixtures.pRetired }]),
      )
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    for (const error of [unspecified, omitted]) {
      const conflict = expectResolutionConflict(error);
      expect(conflict.reason).toBe("no_active_variants");
      expect(conflict.target).toMatchObject({
        kind: "order_line_variant",
        productId: fixtures.pRetired,
      });
      expect(conflict.options).toEqual([]);
    }
    expect(await countCompanyOrders(kitIdentities.companies.a)).toBe(before);
  });

  it("returns NOT_FOUND for archived product and archived variant ids", async () => {
    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerBare, [{ productId: fixtures.pArchived }]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const archivedVariantError = await kit
      .invoke(createOrder, {
        customer: { by: "id", id: fixtures.customerBare },
        items: [
          {
            product: { by: "id", id: fixtures.pVariant },
            variantSelection: {
              kind: "reference",
              ref: { by: "id", id: fixtures.vArchived },
            },
            quantity: { milli: "1000" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (caught: unknown) => caught,
      );
    expect(archivedVariantError).toBeInstanceOf(NotFoundError);
    expect(archivedVariantError).not.toBeInstanceOf(
      ReferenceResolutionConflictError,
    );
    await expect(
      kit.invoke(
        createOrder,
        createById(fixtures.customerBare, [
          { productId: fixtures.pVariant, variantId: fixtures.vArchived },
        ]),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("emits orders.created and denies staff without orders:create", async () => {
    const created = await kit.invoke(createOrder, {
      customer: { by: "id", id: fixtures.customerBare },
      items: [
        {
          product: { by: "id", id: fixtures.pBase },
          variantSelection: { kind: "base" },
          quantity: { milli: "1000" },
        },
      ],
    });
    const createdEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(createdEvents.map((row) => row.name)).toContain("orders.created");

    await expect(
      kit.invoke(
        createOrder,
        {
          customer: { by: "id", id: fixtures.customerBare },
          items: [
            {
              product: { by: "id", id: fixtures.pBase },
              variantSelection: { kind: "base" },
              quantity: { milli: "1000" },
            },
          ],
        },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noCreate,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("leaves historical order-line snapshots stored as written", async () => {
    const seed = await kit.db.runtime.db
      .select({ variantId: orderItems.variantId })
      .from(orderItems)
      .where(eq(orderItems.id, fixtures.itemIsolationA));
    expect(seed[0]?.variantId).toBeNull();
  });
});

describe("orders.cancel", () => {
  it("cancels a new order, writes orders.canceled, and records audit", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    expect(created.status).toBe("new");

    const canceled = await kit.invoke(cancelOrder, {
      orderId: created.orderId,
    });
    expect(canceled).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      status: "canceled",
    });

    const cancelEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(cancelEvents.map((row) => row.name)).toContain("orders.canceled");
    const canceledEvent = cancelEvents.find(
      (row) => row.name === "orders.canceled",
    );
    expect(canceledEvent?.payload).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
    });
    expect(canceledEvent?.aggregateType).toBe("order");

    const cancelAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "orders.cancel"),
          eq(auditLog.targetId, created.orderId),
        ),
      );
    expect(cancelAudit.length).toBeGreaterThanOrEqual(1);
    expect(cancelAudit[0]?.inputSnapshot).toBeNull();
    expect(cancelAudit[0]?.targetType).toBe("order");

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("canceled");
    expect(fetched.items).toHaveLength(1);
    expect(fetched.totalGrossMinor).toBe(created.totalGrossMinor);
  });

  it("cancels a confirmed order without clearing confirmed_at", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    const canceled = await kit.invoke(cancelOrder, {
      orderId: created.orderId,
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.customerId).toBe(fixtures.customerA);

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("canceled");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("cancels an in-progress order without clearing confirmed_at", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    await kit.invoke(startOrder, { orderId: created.orderId });
    const canceled = await kit.invoke(cancelOrder, {
      orderId: created.orderId,
    });
    expect(canceled).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      status: "canceled",
    });
    expect(Object.prototype.hasOwnProperty.call(canceled, "canceledAt")).toBe(
      false,
    );

    const cancelEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.aggregateId, created.orderId),
          eq(domainEvents.name, "orders.canceled"),
        ),
      );
    expect(cancelEvents[0]?.payload).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
    });

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("canceled");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("replays the same idempotency key without changing status or confirmed_at", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    const key = randomUUID();
    const first = await kit.invoke(
      cancelOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    const replay = await kit.invoke(
      cancelOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    expect(replay).toEqual(first);

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("canceled");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("conflicts when canceling an already canceled order and when confirming, starting, or completing after cancel", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(cancelOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(cancelOrder, { orderId: created.orderId }),
      "Order is already canceled.",
    );
    await expectConflict(
      kit.invoke(confirmOrder, { orderId: created.orderId }),
      "Order cannot be confirmed.",
    );
    await expectConflict(
      kit.invoke(startOrder, { orderId: created.orderId }),
      "Order cannot be started.",
    );
    await expectConflict(
      kit.invoke(completeOrder, { orderId: created.orderId }),
      "Order cannot be completed.",
    );
    await expectConflict(
      kit.invoke(cancelOrder, { orderId: fixtures.orderCanceled }),
      "Order is already canceled.",
    );
  });

  it("conflicts when canceling a done order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await kit.invoke(startOrder, { orderId: created.orderId });
    await kit.invoke(completeOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(cancelOrder, { orderId: created.orderId }),
      "Order cannot be canceled.",
    );
  });

  it("returns NotFound for missing and foreign-company orders without leaking existence", async () => {
    const missing = randomUUID();
    const missingOrder = await kit
      .invoke(cancelOrder, { orderId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignOrder = await kit
      .invoke(cancelOrder, { orderId: fixtures.orderCancelIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingOrder).toBeInstanceOf(NotFoundError);
    expect(foreignOrder).toBeInstanceOf(NotFoundError);
    if (
      missingOrder instanceof NotFoundError &&
      foreignOrder instanceof NotFoundError
    ) {
      expect(missingOrder.clientMessage).toBe(foreignOrder.clientMessage);
    }
  });

  it("denies missing orders:edit", async () => {
    await expect(
      kit.invoke(
        cancelOrder,
        { orderId: fixtures.orderCanceled },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noEdit,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a missing idempotency key and a malformed orderId", async () => {
    await expect(
      kit.invoke(
        cancelOrder,
        { orderId: fixtures.orderCanceled },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(cancelOrder, { orderId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("emits null customerId when the CRM row was deleted", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.db.runtime.db
      .update(orders)
      .set({ customerId: null })
      .where(eq(orders.id, created.orderId));

    const canceled = await kit.invoke(cancelOrder, {
      orderId: created.orderId,
    });
    expect(canceled.customerId).toBeNull();

    const cancelEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.aggregateId, created.orderId),
          eq(domainEvents.name, "orders.canceled"),
        ),
      );
    expect(cancelEvents[0]?.payload).toEqual({
      orderId: created.orderId,
      customerId: null,
    });
  });

  it("serializes concurrent cancels of the same new order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "3000" },
      ]),
    );
    const results = await Promise.allSettled([
      kit.invoke(cancelOrder, { orderId: created.orderId }),
      kit.invoke(cancelOrder, { orderId: created.orderId }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0];
    expect(reason?.status).toBe("rejected");
    if (reason?.status === "rejected") {
      expect(
        reason.reason instanceof ConflictError ||
          reason.reason instanceof ConcurrentRetryError,
      ).toBe(true);
    }
    const row = await kit.db.runtime.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, created.orderId));
    expect(row[0]?.status).toBe("canceled");
  });
});

describe("orders.start", () => {
  it("starts a confirmed order, writes orders.started, records audit, and leaves confirmed_at unchanged", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });

    const started = await kit.invoke(startOrder, {
      orderId: created.orderId,
    });
    expect(started).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      status: "in_progress",
    });
    expect(Object.prototype.hasOwnProperty.call(started, "confirmedAt")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(started, "startedAt")).toBe(
      false,
    );

    const startEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(startEvents.map((row) => row.name)).toContain("orders.started");
    const startedEvent = startEvents.find(
      (row) => row.name === "orders.started",
    );
    expect(startedEvent?.payload).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
    });
    expect(startedEvent?.aggregateType).toBe("order");

    const startAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "orders.start"),
          eq(auditLog.targetId, created.orderId),
        ),
      );
    expect(startAudit.length).toBeGreaterThanOrEqual(1);
    expect(startAudit[0]?.inputSnapshot).toBeNull();
    expect(startAudit[0]?.targetType).toBe("order");

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("in_progress");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
    expect(fetched.items).toHaveLength(1);
    expect(fetched.totalGrossMinor).toBe(created.totalGrossMinor);
  });

  it("replays the same idempotency key without changing status or confirmed_at", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    const key = randomUUID();
    const first = await kit.invoke(
      startOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    const replay = await kit.invoke(
      startOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    expect(replay).toEqual(first);

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("in_progress");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("conflicts when starting an already started order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await kit.invoke(startOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(startOrder, { orderId: created.orderId }),
      "Order is already started.",
    );
  });

  it("conflicts when starting from new, done, or canceled", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await expectConflict(
      kit.invoke(startOrder, { orderId: created.orderId }),
      "Order cannot be started.",
    );

    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await kit.invoke(startOrder, { orderId: created.orderId });
    await kit.invoke(completeOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(startOrder, { orderId: created.orderId }),
      "Order cannot be started.",
    );

    const canceled = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(cancelOrder, { orderId: canceled.orderId });
    await expectConflict(
      kit.invoke(startOrder, { orderId: canceled.orderId }),
      "Order cannot be started.",
    );
    await expectConflict(
      kit.invoke(startOrder, { orderId: fixtures.orderCanceled }),
      "Order cannot be started.",
    );
  });

  it("returns NotFound for missing and foreign-company orders without leaking existence", async () => {
    const missing = randomUUID();
    const missingOrder = await kit
      .invoke(startOrder, { orderId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignOrder = await kit
      .invoke(startOrder, { orderId: fixtures.orderStartIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingOrder).toBeInstanceOf(NotFoundError);
    expect(foreignOrder).toBeInstanceOf(NotFoundError);
    if (
      missingOrder instanceof NotFoundError &&
      foreignOrder instanceof NotFoundError
    ) {
      expect(missingOrder.clientMessage).toBe(foreignOrder.clientMessage);
    }
  });

  it("denies missing orders:edit", async () => {
    await expect(
      kit.invoke(
        startOrder,
        { orderId: fixtures.orderCanceled },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noEdit,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a missing idempotency key and a malformed orderId", async () => {
    await expect(
      kit.invoke(
        startOrder,
        { orderId: fixtures.orderCanceled },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(startOrder, { orderId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("serializes concurrent starts of the same confirmed order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "3000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    const results = await Promise.allSettled([
      kit.invoke(startOrder, { orderId: created.orderId }),
      kit.invoke(startOrder, { orderId: created.orderId }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0];
    expect(reason?.status).toBe("rejected");
    if (reason?.status === "rejected") {
      expect(
        reason.reason instanceof ConflictError ||
          reason.reason instanceof ConcurrentRetryError,
      ).toBe(true);
    }
    const row = await kit.db.runtime.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, created.orderId));
    expect(row[0]?.status).toBe("in_progress");
  });
});

describe("orders.complete", () => {
  it("completes an in-progress order, writes orders.completed, records audit, and leaves confirmed_at unchanged", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    await kit.invoke(startOrder, { orderId: created.orderId });

    const completed = await kit.invoke(completeOrder, {
      orderId: created.orderId,
    });
    expect(completed).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
      status: "done",
    });
    expect(Object.prototype.hasOwnProperty.call(completed, "confirmedAt")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(completed, "completedAt")).toBe(
      false,
    );

    const completeEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.orderId));
    expect(completeEvents.map((row) => row.name)).toContain("orders.completed");
    const completedEvent = completeEvents.find(
      (row) => row.name === "orders.completed",
    );
    expect(completedEvent?.payload).toEqual({
      orderId: created.orderId,
      customerId: fixtures.customerA,
    });
    expect(completedEvent?.aggregateType).toBe("order");

    const completeAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "orders.complete"),
          eq(auditLog.targetId, created.orderId),
        ),
      );
    expect(completeAudit.length).toBeGreaterThanOrEqual(1);
    expect(completeAudit[0]?.inputSnapshot).toBeNull();
    expect(completeAudit[0]?.targetType).toBe("order");

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("done");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
    expect(fetched.items).toHaveLength(1);
    expect(fetched.totalGrossMinor).toBe(created.totalGrossMinor);
  });

  it("replays the same idempotency key without changing status or confirmed_at", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerA, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    const confirmed = await kit.invoke(confirmOrder, {
      orderId: created.orderId,
    });
    await kit.invoke(startOrder, { orderId: created.orderId });
    const key = randomUUID();
    const first = await kit.invoke(
      completeOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    const replay = await kit.invoke(
      completeOrder,
      { orderId: created.orderId },
      {},
      { request: { idempotencyKey: key } },
    );
    expect(replay).toEqual(first);

    const fetched = await kit.invoke(getOrder, { orderId: created.orderId });
    expect(fetched.status).toBe("done");
    expect(fetched.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it("conflicts when completing an already completed order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await kit.invoke(startOrder, { orderId: created.orderId });
    await kit.invoke(completeOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(completeOrder, { orderId: created.orderId }),
      "Order is already completed.",
    );
  });

  it("conflicts when completing from new, confirmed, or canceled", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await expectConflict(
      kit.invoke(completeOrder, { orderId: created.orderId }),
      "Order cannot be completed.",
    );

    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await expectConflict(
      kit.invoke(completeOrder, { orderId: created.orderId }),
      "Order cannot be completed.",
    );

    const canceled = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "1000" },
      ]),
    );
    await kit.invoke(cancelOrder, { orderId: canceled.orderId });
    await expectConflict(
      kit.invoke(completeOrder, { orderId: canceled.orderId }),
      "Order cannot be completed.",
    );
    await expectConflict(
      kit.invoke(completeOrder, { orderId: fixtures.orderCanceled }),
      "Order cannot be completed.",
    );
  });

  it("returns NotFound for missing and foreign-company orders without leaking existence", async () => {
    const missing = randomUUID();
    const missingOrder = await kit
      .invoke(completeOrder, { orderId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignOrder = await kit
      .invoke(completeOrder, { orderId: fixtures.orderCompleteIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingOrder).toBeInstanceOf(NotFoundError);
    expect(foreignOrder).toBeInstanceOf(NotFoundError);
    if (
      missingOrder instanceof NotFoundError &&
      foreignOrder instanceof NotFoundError
    ) {
      expect(missingOrder.clientMessage).toBe(foreignOrder.clientMessage);
    }
  });

  it("denies missing orders:edit", async () => {
    await expect(
      kit.invoke(
        completeOrder,
        { orderId: fixtures.orderCanceled },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noEdit,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a missing idempotency key and a malformed orderId", async () => {
    await expect(
      kit.invoke(
        completeOrder,
        { orderId: fixtures.orderCanceled },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(completeOrder, { orderId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("serializes concurrent completes of the same in-progress order", async () => {
    const created = await kit.invoke(
      createOrder,
      createById(fixtures.customerBare, [
        { productId: fixtures.pZero, quantityMilli: "3000" },
      ]),
    );
    await kit.invoke(confirmOrder, { orderId: created.orderId });
    await kit.invoke(startOrder, { orderId: created.orderId });
    const results = await Promise.allSettled([
      kit.invoke(completeOrder, { orderId: created.orderId }),
      kit.invoke(completeOrder, { orderId: created.orderId }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0];
    expect(reason?.status).toBe("rejected");
    if (reason?.status === "rejected") {
      expect(
        reason.reason instanceof ConflictError ||
          reason.reason instanceof ConcurrentRetryError,
      ).toBe(true);
    }
    const row = await kit.db.runtime.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, created.orderId));
    expect(row[0]?.status).toBe("done");
  });
});
