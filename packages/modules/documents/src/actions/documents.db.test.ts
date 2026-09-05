import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import {
  defineEventHandler,
  eventEnvelopeSchema,
  implementAction,
} from "@showzy/core";
import {
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
import { products } from "@showzy/db/schema/catalog";
import {
  companies,
  companyLegalInfo,
  companyMembers,
} from "@showzy/db/schema/companies";
import { companyCustomers, counterparties } from "@showzy/db/schema/customers";
import { documents } from "@showzy/db/schema/documents";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createFromOrder } from "./create-from-order.js";
import { DOCUMENT_BASIS_MAX } from "./document-view.contract.js";
import { getForGeneration } from "./get-for-generation.js";
import { getDocument } from "./get.js";
import { documentsCreated } from "../events/created.js";
import { CANCELED_ORDER_MESSAGE } from "../services/create-from-order.js";
import { kyivCalendarDay } from "../services/kyiv-calendar-day.js";
import {
  COUNTERPARTY_CUSTOMER_MISMATCH_MESSAGE,
  MISSING_BUYER_MESSAGE,
  MISSING_SELLER_LEGAL_MESSAGE,
} from "../services/snapshots.js";
import { DUPLICATE_LIVE_DOCUMENT_MESSAGE } from "../services/unique-violations.js";

const TEST_CREATED_CONSUMER = "documents.test-created-noop";

const fixtures = {
  customerA: randomUUID(),
  customerMismatch: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  productNoLegal: randomUUID(),
  customerNoLegal: randomUUID(),
  counterpartyLinked: randomUUID(),
  counterpartyMismatch: randomUUID(),
  counterpartyStandalone: randomUUID(),
  counterpartyB: randomUUID(),
  companyNoLegal: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderIdempotency: randomUUID(),
  orderIdempotencyConcurrent: randomUUID(),
  orderEvent: randomUUID(),
  orderInvoice: randomUUID(),
  orderDelivery: randomUUID(),
  orderCanceled: randomUUID(),
  orderDuplicate: randomUUID(),
  orderNoCustomer: randomUUID(),
  orderMismatch: randomUUID(),
  orderNoLegal: randomUUID(),
  orderNumbering1: randomUUID(),
  orderNumbering2: randomUUID(),
  orderNumbering3: randomUUID(),
  orderLayoutPlain: randomUUID(),
  orderBasis: randomUUID(),
  orderEmptyBasis: randomUUID(),
  itemIsolationA: randomUUID(),
  itemIsolationB: randomUUID(),
  itemIdempotency: randomUUID(),
  itemIdempotencyConcurrent: randomUUID(),
  itemEvent: randomUUID(),
  itemInvoice: randomUUID(),
  itemDelivery: randomUUID(),
  itemCanceled: randomUUID(),
  itemDuplicate: randomUUID(),
  itemNoCustomer: randomUUID(),
  itemMismatch: randomUUID(),
  itemNoLegal: randomUUID(),
  itemNumbering1: randomUUID(),
  itemNumbering2: randomUUID(),
  itemNumbering3: randomUUID(),
  itemLayoutPlain: randomUUID(),
  itemBasis: randomUUID(),
  itemEmptyBasis: randomUUID(),
};

const clerks = {
  noCreate: randomUUID(),
};

const sampleIban = "UA123456789012345678901234567";
const foreignIban = "UA999999999999999999999999999";

let kit: TestKit;
const seedOrderNumbers = new Map<string, number>();

const emitCreatedThenFail = implementAction(
  defineActionContract({
    name: "documents.emitCreatedThenFail",
    description:
      "Test-local emitter that fails after buffering documents.created.",
    principal: "staff",
    transport: "internal",
    input: z.object({ documentId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:create"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["documents.created"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(documentsCreated, {
        aggregate: { type: "document", id: input.documentId },
        payload: {
          documentId: input.documentId,
          orderId: fixtures.orderEvent,
          type: "payment_invoice",
          documentNumber: "KA-РХ-000000",
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: (env) => {
      const input = env.input;
      const documentId =
        typeof input === "object" &&
        input !== null &&
        "documentId" in input &&
        typeof input.documentId === "string"
          ? input.documentId
          : "unknown";
      return { type: "document", id: documentId };
    },
  },
);

const projectCreatedTest = implementAction(
  defineActionContract({
    name: "documents.projectCreatedTest",
    description: "Test-local no-op consumer of documents.created.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(documentsCreated.payload),
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
    auditTarget: () => ({ type: "document", id: "test-created-noop" }),
  },
);

const createdNoop = defineEventHandler({
  event: documentsCreated,
  consumer: TEST_CREATED_CONSUMER,
  action: projectCreatedTest,
});

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

async function insertSeedOrder(values: {
  id: string;
  itemId: string;
  companyId: string;
  customerId: string | null;
  productId: string;
  status: "new" | "canceled";
  unitPriceMinor?: bigint;
}): Promise<void> {
  const unit = values.unitPriceMinor ?? 250n;
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: nextSeedOrderNumber(values.companyId),
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: values.status,
    totalNetMinor: unit,
    totalTaxMinor: 0n,
    totalGrossMinor: unit,
    currency: "UAH",
  });
  await kit.db.runtime.db.insert(orderItems).values({
    id: values.itemId,
    companyId: values.companyId,
    orderId: values.id,
    productId: values.productId,
    titleSnapshot: "Seed line",
    quantityMilli: 1000n,
    unitPriceMinor: unit,
    taxTreatment: "exempt",
    netAmountMinor: unit,
    grossAmountMinor: unit,
    priceSource: "base",
    resolverVersion: 1,
  });
}

async function countCompanyDocuments(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.companyId, companyId));
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

function sequenceFromNumber(documentNumber: string): number {
  const parts = documentNumber.split("-");
  const seq = parts[2];
  if (seq === undefined) {
    throw new Error(`document number ${documentNumber} has no sequence`);
  }
  return Number.parseInt(seq, 10);
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(companyLegalInfo).values([
    {
      companyId: companyA,
      companyType: "tov",
      legalName: "ТОВ Альфа",
      edrpou: "12345678",
      legalAddress: "вул. Хрещатик, 1",
      iban: sampleIban,
      bankName: "ПриватБанк",
      bankMfo: "300001",
      bankEdrpou: "12345678",
      phone: "+380501111111",
      email: "legal@alpha.test",
    },
    {
      companyId: companyB,
      companyType: "fop",
      legalName: "ФОП Борис",
      edrpou: "87654321",
      iban: foreignIban,
    },
  ]);

  await kit.db.runtime.db.insert(companies).values({
    id: fixtures.companyNoLegal,
    name: "No Legal Co",
    slug: "no-legal-docs",
    prefix: "NL",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: fixtures.companyNoLegal,
    userId: kitIdentities.users.anna,
    role: "owner",
    permissions: { granted: [], denied: [] },
  });

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      email: `customer-${fixtures.customerA}@example.com`,
    },
    {
      id: fixtures.customerMismatch,
      companyId: companyA,
      name: "Customer mismatch",
      email: `customer-${fixtures.customerMismatch}@example.com`,
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      email: `customer-${fixtures.customerB}@example.com`,
    },
    {
      id: fixtures.customerNoLegal,
      companyId: fixtures.companyNoLegal,
      name: "Customer NL",
      email: `customer-${fixtures.customerNoLegal}@example.com`,
    },
  ]);

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: companyA,
      name: "Cake",
      basePriceMinor: 250n,
    },
    {
      id: fixtures.productB,
      companyId: companyB,
      name: "Foreign cake",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productNoLegal,
      companyId: fixtures.companyNoLegal,
      name: "NL cake",
      basePriceMinor: 100n,
    },
  ]);

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.counterpartyLinked,
      companyId: companyA,
      customerId: fixtures.customerA,
      name: "ТОВ Покупець",
      edrpou: "11223344",
      legalAddress: "вул. Покупця, 2",
      iban: "UA111111111111111111111111111",
      bankName: "Ощадбанк",
      bankMfo: "300335",
      phone: "+380502222222",
      email: "buyer@example.com",
      notes: "Linked buyer",
    },
    {
      id: fixtures.counterpartyMismatch,
      companyId: companyA,
      customerId: fixtures.customerMismatch,
      name: "ТОВ Інший",
      edrpou: "44332211",
    },
    {
      id: fixtures.counterpartyStandalone,
      companyId: companyA,
      name: "ТОВ Самостійний",
      edrpou: "55667788",
    },
    {
      id: fixtures.counterpartyB,
      companyId: companyB,
      customerId: fixtures.customerB,
      name: "Foreign CP",
    },
  ]);

  const ordersA: Array<{
    id: string;
    itemId: string;
    customerId: string | null;
    status: "new" | "canceled";
  }> = [
    {
      id: fixtures.orderIsolationA,
      itemId: fixtures.itemIsolationA,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderIdempotency,
      itemId: fixtures.itemIdempotency,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderIdempotencyConcurrent,
      itemId: fixtures.itemIdempotencyConcurrent,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderEvent,
      itemId: fixtures.itemEvent,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderInvoice,
      itemId: fixtures.itemInvoice,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderDelivery,
      itemId: fixtures.itemDelivery,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderCanceled,
      itemId: fixtures.itemCanceled,
      customerId: fixtures.customerA,
      status: "canceled",
    },
    {
      id: fixtures.orderDuplicate,
      itemId: fixtures.itemDuplicate,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderNoCustomer,
      itemId: fixtures.itemNoCustomer,
      customerId: null,
      status: "new",
    },
    {
      id: fixtures.orderMismatch,
      itemId: fixtures.itemMismatch,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderNumbering1,
      itemId: fixtures.itemNumbering1,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderNumbering2,
      itemId: fixtures.itemNumbering2,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderNumbering3,
      itemId: fixtures.itemNumbering3,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderLayoutPlain,
      itemId: fixtures.itemLayoutPlain,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderBasis,
      itemId: fixtures.itemBasis,
      customerId: fixtures.customerA,
      status: "new",
    },
    {
      id: fixtures.orderEmptyBasis,
      itemId: fixtures.itemEmptyBasis,
      customerId: fixtures.customerA,
      status: "new",
    },
  ];
  for (const row of ordersA) {
    await insertSeedOrder({
      id: row.id,
      itemId: row.itemId,
      companyId: companyA,
      customerId: row.customerId,
      productId: fixtures.productA,
      status: row.status,
    });
  }
  await insertSeedOrder({
    id: fixtures.orderIsolationB,
    itemId: fixtures.itemIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
    status: "new",
  });
  await insertSeedOrder({
    id: fixtures.orderNoLegal,
    itemId: fixtures.itemNoLegal,
    companyId: fixtures.companyNoLegal,
    customerId: fixtures.customerNoLegal,
    productId: fixtures.productNoLegal,
    status: "new",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noCreate,
    name: "No create",
    email: "nocreate@documents-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.noCreate,
    role: "employee",
    permissions: { granted: [], denied: ["documents:create"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      createFromOrder,
      { input: { orderId: fixtures.orderIsolationA, type: "payment_invoice" } },
      { input: { orderId: fixtures.orderIsolationB, type: "payment_invoice" } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createFromOrder,
      input: { orderId: fixtures.orderIdempotency, type: "payment_invoice" },
      conflictingInput: {
        orderId: fixtures.orderIdempotency,
        type: "delivery_note",
      },
      freshInput: () => ({
        orderId: fixtures.orderIdempotencyConcurrent,
        type: "payment_invoice",
      }),
      readEffect: () => countCompanyDocuments(kitIdentities.companies.a),
    },
  ],
);

eventSuite(() => kit, {
  module: "documents",
  emitAction: createFromOrder,
  emitInput: { orderId: fixtures.orderEvent, type: "payment_invoice" },
  failingEmitAction: emitCreatedThenFail,
  failingEmitInput: { documentId: randomUUID() },
  eventName: "documents.created",
  subscription: createdNoop,
  readProjection: processedCreatedDeliveries,
});

describe("documents.createFromOrder", () => {
  it("issues a payment invoice with a customer-name buyer and copies line snapshots", async () => {
    const beforeDay = kyivCalendarDay(new Date());
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderInvoice,
      type: "payment_invoice",
    });
    const afterDay = kyivCalendarDay(new Date());

    expect(created.status).toBe("issued");
    expect(created.type).toBe("payment_invoice");
    expect(created.orderId).toBe(fixtures.orderInvoice);
    expect(created.counterpartyId).toBeNull();
    expect(created.documentNumber).toMatch(/^KA-РХ-\d{6}$/);
    expect(created.documentNumber).not.toMatch(/20\d{2}/);
    expect([beforeDay, afterDay]).toContain(created.issuedOn);
    expect(created.templateSource).toBe("system");
    expect(created.templateName).toBe("payment_invoice.branded");
    expect(created.basis).toBeNull();
    expect(created.buyerDetails).toEqual({
      kind: "customer",
      displayName: "Customer A",
    });
    expect(created.supplierDetails).toMatchObject({
      kind: "seller",
      name: "Konditerska Anna",
      prefix: "KA",
      companyType: "tov",
      legalName: "ТОВ Альфа",
      iban: sampleIban,
    });
    expect(JSON.stringify(created.supplierDetails)).not.toContain(foreignIban);
    expect(created.items).toHaveLength(1);
    expect(created.items[0]).toMatchObject({
      productId: fixtures.productA,
      titleSnapshot: "Seed line",
      quantityMilli: "1000",
      unitPriceMinor: "250",
      netAmountMinor: "250",
      grossAmountMinor: "250",
      taxAmountMinor: "0",
      taxTreatment: "exempt",
      discountKind: "none",
      currency: "UAH",
    });
    expect(created.totalNetMinor).toBe("250");
    expect(created.totalTaxMinor).toBe("0");
    expect(created.totalGrossMinor).toBe("250");

    const events = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.documentId));
    expect(events.map((row) => row.name)).toContain("documents.created");
    const createdEvent = events.find((row) => row.name === "documents.created");
    expect(createdEvent?.payload).toMatchObject({
      documentId: created.documentId,
      orderId: fixtures.orderInvoice,
      type: "payment_invoice",
      documentNumber: created.documentNumber,
    });
    expect(createdEvent?.aggregateType).toBe("document");

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "documents.createFromOrder"),
          eq(auditLog.targetId, created.documentId),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0]?.targetType).toBe("document");
    expect(auditRows[0]?.inputSnapshot).toBeNull();
  });

  it("issues a delivery note with a counterparty legal-face buyer", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderDelivery,
      type: "delivery_note",
      counterpartyId: fixtures.counterpartyLinked,
    });
    expect(created.type).toBe("delivery_note");
    expect(created.documentNumber).toMatch(/^KA-ВН-\d{6}$/);
    expect(created.counterpartyId).toBe(fixtures.counterpartyLinked);
    expect(created.buyerDetails).toMatchObject({
      kind: "counterparty",
      name: "ТОВ Покупець",
      edrpou: "11223344",
      legalAddress: "вул. Покупця, 2",
    });
    expect(created.templateName).toBe("delivery_note.parties");
    expect(created.basis).toBeNull();
  });

  it("allows a standalone counterparty when the order has a customer", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderNumbering1,
      type: "delivery_note",
      counterpartyId: fixtures.counterpartyStandalone,
    });
    expect(created.buyerDetails).toMatchObject({
      kind: "counterparty",
      name: "ТОВ Самостійний",
      edrpou: "55667788",
    });
  });

  it("assigns monotonic per-type numbers with no year", async () => {
    const first = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderNumbering2,
      type: "payment_invoice",
    });
    const second = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderNumbering3,
      type: "payment_invoice",
    });
    expect(first.documentNumber).toMatch(/^KA-РХ-\d{6}$/);
    expect(second.documentNumber).toMatch(/^KA-РХ-\d{6}$/);
    expect(first.documentNumber).not.toMatch(/20\d{2}/);
    expect(second.documentNumber).not.toMatch(/20\d{2}/);
    expect(sequenceFromNumber(second.documentNumber)).toBe(
      sequenceFromNumber(first.documentNumber) + 1,
    );
  });

  it("rejects missing seller legal", async () => {
    await expect(
      kit.invoke(
        createFromOrder,
        { orderId: fixtures.orderNoLegal, type: "payment_invoice" },
        { companyId: fixtures.companyNoLegal },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === MISSING_SELLER_LEGAL_MESSAGE
      );
    });
  });

  it("rejects a canceled order", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderCanceled,
        type: "payment_invoice",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === CANCELED_ORDER_MESSAGE
      );
    });
  });

  it("rejects a duplicate live document of the same type", async () => {
    await kit.invoke(createFromOrder, {
      orderId: fixtures.orderDuplicate,
      type: "payment_invoice",
    });
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderDuplicate,
        type: "payment_invoice",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === DUPLICATE_LIVE_DOCUMENT_MESSAGE
      );
    });
  });

  it("rejects CRM-deleted order with no counterparty", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderNoCustomer,
        type: "payment_invoice",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === MISSING_BUYER_MESSAGE
      );
    });
  });

  it("rejects a counterparty linked to a different customer", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        counterpartyId: fixtures.counterpartyMismatch,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === COUNTERPARTY_CUSTOMER_MISMATCH_MESSAGE
      );
    });
  });

  it("returns not-found for missing and foreign ids", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: randomUUID(),
        type: "payment_invoice",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderIsolationB,
        type: "payment_invoice",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        counterpartyId: fixtures.counterpartyB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        counterpartyId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies staff without documents:create", async () => {
    await expect(
      kit.invoke(
        createFromOrder,
        { orderId: fixtures.orderMismatch, type: "payment_invoice" },
        { userId: clerks.noCreate, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("persists an explicit layoutKey as the canonical templateName", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderLayoutPlain,
      type: "payment_invoice",
      layoutKey: "payment_invoice.branded",
    });
    expect(created.templateName).toBe("payment_invoice.branded");
    expect(created.basis).toBeNull();
    const loaded = await kit.invoke(getDocument, {
      documentId: created.documentId,
    });
    expect(loaded.templateName).toBe("payment_invoice.branded");
    expect(loaded.basis).toBeNull();
  });

  it("round-trips basis on get and getForGeneration", async () => {
    const basis = "Договір поставки № 15/2026 від 10.01.2026 р.";
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderBasis,
      type: "delivery_note",
      layoutKey: "delivery_note.parties",
      counterpartyId: fixtures.counterpartyLinked,
      basis,
    });
    expect(created.templateName).toBe("delivery_note.parties");
    expect(created.basis).toBe(basis);

    const staffGet = await kit.invoke(getDocument, {
      documentId: created.documentId,
    });
    expect(staffGet.templateName).toBe("delivery_note.parties");
    expect(staffGet.basis).toBe(basis);

    const generation = await kit.invoke(getForGeneration, {
      documentId: created.documentId,
    });
    expect(generation.templateName).toBe("delivery_note.parties");
    expect(generation.basis).toBe(basis);
  });

  it("stores a blank basis as null", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderEmptyBasis,
      type: "payment_invoice",
      basis: "   ",
    });
    expect(created.basis).toBeNull();
    expect(created.templateName).toBe("payment_invoice.branded");
  });

  it("rejects an unknown layoutKey", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        layoutKey: "payment_invoice.custom",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === "Unknown document layout."
      );
    });
  });

  it("rejects a layoutKey for the other document type", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        layoutKey: "delivery_note.parties",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === "Layout key does not match document type."
      );
    });
  });

  it("rejects basis over 500 characters", async () => {
    await expect(
      kit.invoke(createFromOrder, {
        orderId: fixtures.orderMismatch,
        type: "payment_invoice",
        basis: "x".repeat(DOCUMENT_BASIS_MAX + 1),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
