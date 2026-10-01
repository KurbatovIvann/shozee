import { randomUUID } from "node:crypto";

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
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyLegalInfo, companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  signingRequests,
  signingSignatures,
} from "@showzy/db/schema/doc-signing";
import { documentNumberCounters, documents } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ALREADY_CANCELLED_MESSAGE,
  cancelDocument,
  SIGNED_CANNOT_CANCEL_MESSAGE,
} from "./cancel.js";
import { createFromOrder } from "./create-from-order.js";
import { getDocument } from "./get.js";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderIdempotency: randomUUID(),
  orderIdempotencyConcurrent: randomUUID(),
  orderIdempotencyConflict: randomUUID(),
  orderHappy: randomUUID(),
  orderRecreate: randomUUID(),
  orderConcurrent: randomUUID(),
  itemIsolationA: randomUUID(),
  itemIsolationB: randomUUID(),
  itemIdempotency: randomUUID(),
  itemIdempotencyConcurrent: randomUUID(),
  itemIdempotencyConflict: randomUUID(),
  itemHappy: randomUUID(),
  itemRecreate: randomUUID(),
  itemConcurrent: randomUUID(),
  docIsolationA: randomUUID(),
  docIsolationB: randomUUID(),
  docIdempotency: randomUUID(),
  docIdempotencyConcurrent: randomUUID(),
  docIdempotencyConflict: randomUUID(),
  orderSigned: randomUUID(),
  itemSigned: randomUUID(),
  docSigned: randomUUID(),
  asicSigned: randomUUID(),
  signatureSigned: randomUUID(),
  orderGrant: randomUUID(),
  itemGrant: randomUUID(),
  docGrant: randomUUID(),
  pdfGrant: randomUUID(),
  requestGrant: randomUUID(),
};

const clerks = {
  noEdit: randomUUID(),
};

const sampleIban = "UA123456789012345678901234567";
const foreignIban = "UA999999999999999999999999999";

const sellerSnapshot = {
  kind: "seller" as const,
  name: "Konditerska Anna",
  prefix: "KA",
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
  edrpou: "12345678",
  legalAddress: "вул. Хрещатик, 1",
  iban: sampleIban,
  bankName: "ПриватБанк",
  bankMfo: "300001",
  bankEdrpou: "12345678",
  phone: "+380501111111",
  email: "legal@alpha.test",
};

const customerBuyerSnapshot = {
  kind: "customer" as const,
  displayName: "Customer A",
};

let kit: TestKit;
const seedOrderNumbers = new Map<string, number>();

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
}): Promise<void> {
  const unit = 250n;
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: nextSeedOrderNumber(values.companyId),
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: "new",
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

async function insertSeedDocument(values: {
  id: string;
  companyId: string;
  orderId: string;
  documentNumber: string;
  status: "issued" | "cancelled";
}): Promise<void> {
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId: values.orderId,
    counterpartyId: null,
    type: "payment_invoice",
    status: values.status,
    documentNumber: values.documentNumber,
    issuedOn: "2026-03-15",
    supplierDetails: sellerSnapshot,
    buyerDetails: customerBuyerSnapshot,
    totalNetMinor: 250n,
    totalTaxMinor: 0n,
    totalGrossMinor: 250n,
    currency: "UAH",
    templateSource: "system",
    templateName: "payment_invoice",
  });
}

async function countCancelled(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.status, "cancelled"),
      ),
    );
  return rows.length;
}

async function readCounter(
  companyId: string,
  type: "payment_invoice" | "delivery_note",
): Promise<bigint | undefined> {
  const rows = await kit.db.runtime.db
    .select({ lastNumber: documentNumberCounters.lastNumber })
    .from(documentNumberCounters)
    .where(
      and(
        eq(documentNumberCounters.companyId, companyId),
        eq(documentNumberCounters.type, type),
      ),
    );
  return rows[0]?.lastNumber;
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

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      email: `customer-${fixtures.customerA}@example.com`,
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      email: `customer-${fixtures.customerB}@example.com`,
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
  ]);

  await insertSeedOrder({
    id: fixtures.orderIsolationA,
    itemId: fixtures.itemIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderIsolationB,
    itemId: fixtures.itemIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
  });
  await insertSeedOrder({
    id: fixtures.orderIdempotency,
    itemId: fixtures.itemIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderIdempotencyConcurrent,
    itemId: fixtures.itemIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderIdempotencyConflict,
    itemId: fixtures.itemIdempotencyConflict,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderHappy,
    itemId: fixtures.itemHappy,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderRecreate,
    itemId: fixtures.itemRecreate,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderConcurrent,
    itemId: fixtures.itemConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderSigned,
    itemId: fixtures.itemSigned,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });
  await insertSeedOrder({
    id: fixtures.orderGrant,
    itemId: fixtures.itemGrant,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
  });

  await insertSeedDocument({
    id: fixtures.docIsolationA,
    companyId: companyA,
    orderId: fixtures.orderIsolationA,
    documentNumber: "KA-РХ-000900",
    status: "issued",
  });
  await insertSeedDocument({
    id: fixtures.docIsolationB,
    companyId: companyB,
    orderId: fixtures.orderIsolationB,
    documentNumber: "MB-РХ-000900",
    status: "issued",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotency,
    companyId: companyA,
    orderId: fixtures.orderIdempotency,
    documentNumber: "KA-РХ-000901",
    status: "issued",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotencyConcurrent,
    companyId: companyA,
    orderId: fixtures.orderIdempotencyConcurrent,
    documentNumber: "KA-РХ-000902",
    status: "issued",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotencyConflict,
    companyId: companyA,
    orderId: fixtures.orderIdempotencyConflict,
    documentNumber: "KA-РХ-000903",
    status: "cancelled",
  });
  await insertSeedDocument({
    id: fixtures.docSigned,
    companyId: companyA,
    orderId: fixtures.orderSigned,
    documentNumber: "KA-РХ-000904",
    status: "issued",
  });
  await insertSeedDocument({
    id: fixtures.docGrant,
    companyId: companyA,
    orderId: fixtures.orderGrant,
    documentNumber: "KA-РХ-000905",
    status: "issued",
  });

  await kit.db.runtime.db.insert(files).values({
    id: fixtures.asicSigned,
    companyId: companyA,
    uploadedByUserId: kitIdentities.users.anna,
    purpose: "signing",
    mimeType: "application/vnd.etsi.asic-e+zip",
    byteSize: 2048n,
    objectKey: `${companyA}/signing/${fixtures.asicSigned}`,
    status: "ready",
    checksumSha256: "b".repeat(64),
    stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
  await kit.db.runtime.db.insert(files).values({
    id: fixtures.pdfGrant,
    companyId: companyA,
    purpose: "document",
    mimeType: "application/pdf",
    byteSize: 1024n,
    objectKey: `${companyA}/documents/${fixtures.pdfGrant}`,
    status: "ready",
    checksumSha256: "a".repeat(64),
    stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
  await kit.db.runtime.db.insert(signingSignatures).values({
    id: fixtures.signatureSigned,
    companyId: companyA,
    documentId: fixtures.docSigned,
    signerRole: "supplier",
    fileId: fixtures.asicSigned,
    signerCn: "ФОП Fixture",
    signerOrg: "Fixture Org",
    signerTaxId: "12345678",
    signatureAlg: "DSTU4145",
    signedAt: new Date("2026-08-30T12:00:00.000Z"),
  });
  await kit.db.runtime.db.insert(signingRequests).values({
    id: fixtures.requestGrant,
    companyId: companyA,
    documentId: fixtures.docGrant,
    payloadFileId: fixtures.pdfGrant,
    payloadSha256: "a".repeat(64),
    status: "pending",
  });
  await kit.db.runtime.db
    .update(documents)
    .set({ signRequestedAt: new Date("2026-08-30T11:00:00.000Z") })
    .where(eq(documents.id, fixtures.docGrant));

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noEdit,
    name: "No edit",
    email: "noedit@documents-cancel-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.noEdit,
    role: "employee",
    permissions: { granted: [], denied: ["documents:edit"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      cancelDocument,
      { input: { documentId: fixtures.docIsolationA } },
      { input: { documentId: fixtures.docIsolationB } },
      { missing: { input: { documentId: randomUUID() } } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: cancelDocument,
      input: { documentId: fixtures.docIdempotency },
      conflictingInput: { documentId: fixtures.docIdempotencyConflict },
      freshInput: () => ({ documentId: fixtures.docIdempotencyConcurrent }),
      readEffect: () => countCancelled(kitIdentities.companies.a),
    },
  ],
);

describe("documents.cancel", () => {
  it("cancels an issued document, writes documents.cancelled, and records audit", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderHappy,
      type: "payment_invoice",
    });
    expect(created.status).toBe("issued");
    const numberBefore = created.documentNumber;
    const counterBefore = await readCounter(
      kitIdentities.companies.a,
      "payment_invoice",
    );
    expect(counterBefore).toBeDefined();

    const cancelled = await kit.invoke(cancelDocument, {
      documentId: created.documentId,
    });
    expect(cancelled).toEqual({
      documentId: created.documentId,
      orderId: fixtures.orderHappy,
      status: "cancelled",
    });

    const header = await kit.db.runtime.db
      .select({
        status: documents.status,
        documentNumber: documents.documentNumber,
      })
      .from(documents)
      .where(eq(documents.id, created.documentId));
    expect(header[0]?.status).toBe("cancelled");
    expect(header[0]?.documentNumber).toBe(numberBefore);

    const counterAfter = await readCounter(
      kitIdentities.companies.a,
      "payment_invoice",
    );
    expect(counterAfter).toBe(counterBefore);

    const cancelEvents = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, created.documentId));
    expect(cancelEvents.map((row) => row.name)).toContain(
      "documents.cancelled",
    );
    const cancelledEvent = cancelEvents.find(
      (row) => row.name === "documents.cancelled",
    );
    expect(cancelledEvent?.payload).toEqual({
      documentId: created.documentId,
      orderId: fixtures.orderHappy,
    });
    expect(cancelledEvent?.aggregateType).toBe("document");

    const cancelAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "documents.cancel"),
          eq(auditLog.targetId, created.documentId),
        ),
      );
    expect(cancelAudit.length).toBeGreaterThanOrEqual(1);
    expect(cancelAudit[0]?.inputSnapshot).toBeNull();
    expect(cancelAudit[0]?.targetType).toBe("document");

    const fetched = await kit.invoke(getDocument, {
      documentId: created.documentId,
    });
    expect(fetched.status).toBe("cancelled");
    expect(fetched.documentNumber).toBe(numberBefore);
    expect(fetched.items).toHaveLength(1);
    expect(fetched.signing).toEqual({ status: "unsigned" });
    expect(fetched).toHaveProperty("pdfDownloadUrl");
  });

  it("lets createFromOrder issue the same order and type after cancel", async () => {
    const first = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderRecreate,
      type: "payment_invoice",
    });
    const firstNumber = first.documentNumber;
    const counterBeforeCancel = await readCounter(
      kitIdentities.companies.a,
      "payment_invoice",
    );
    if (counterBeforeCancel === undefined) {
      throw new Error(
        "expected a payment_invoice counter after the first issue",
      );
    }

    await kit.invoke(cancelDocument, { documentId: first.documentId });

    const second = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderRecreate,
      type: "payment_invoice",
    });
    expect(second.documentId).not.toBe(first.documentId);
    expect(second.status).toBe("issued");
    expect(second.orderId).toBe(fixtures.orderRecreate);
    expect(second.type).toBe("payment_invoice");
    expect(sequenceFromNumber(second.documentNumber)).toBe(
      sequenceFromNumber(firstNumber) + 1,
    );

    const stillFirst = await kit.invoke(getDocument, {
      documentId: first.documentId,
    });
    expect(stillFirst.status).toBe("cancelled");
    expect(stillFirst.documentNumber).toBe(firstNumber);

    const counterAfterSecond = await readCounter(
      kitIdentities.companies.a,
      "payment_invoice",
    );
    expect(counterAfterSecond).toBe(counterBeforeCancel + 1n);
  });

  it("conflicts when canceling an already cancelled document", async () => {
    await expect(
      kit.invoke(cancelDocument, {
        documentId: fixtures.docIdempotencyConflict,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === ALREADY_CANCELLED_MESSAGE
      );
    });

    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderHappy,
      type: "delivery_note",
    });
    await kit.invoke(cancelDocument, { documentId: created.documentId });
    await expect(
      kit.invoke(cancelDocument, { documentId: created.documentId }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns NotFound for missing and foreign-company documents without leaking existence", async () => {
    const missing = randomUUID();
    const missingDocument = await kit
      .invoke(cancelDocument, { documentId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignDocument = await kit
      .invoke(cancelDocument, { documentId: fixtures.docIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingDocument).toBeInstanceOf(NotFoundError);
    expect(foreignDocument).toBeInstanceOf(NotFoundError);
    if (
      missingDocument instanceof NotFoundError &&
      foreignDocument instanceof NotFoundError
    ) {
      expect(missingDocument.clientMessage).toBe(foreignDocument.clientMessage);
    }
  });

  it("denies missing documents:edit", async () => {
    await expect(
      kit.invoke(
        cancelDocument,
        { documentId: fixtures.docIdempotencyConflict },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noEdit,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("conflicts when a supplier signature exists via nested signing read", async () => {
    await expect(
      kit.invoke(cancelDocument, { documentId: fixtures.docSigned }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === SIGNED_CANNOT_CANCEL_MESSAGE
      );
    });
    const header = await kit.db.runtime.db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, fixtures.docSigned));
    expect(header[0]?.status).toBe("issued");
  });

  it("clears sign_requested_at on unsigned cancel even when a request is pending", async () => {
    const before = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, fixtures.docGrant));
    expect(before[0]?.signRequestedAt).not.toBeNull();
    const pendingBefore = await kit.db.runtime.db
      .select({ id: signingRequests.id })
      .from(signingRequests)
      .where(eq(signingRequests.id, fixtures.requestGrant));
    expect(pendingBefore).toHaveLength(1);

    await kit.invoke(cancelDocument, { documentId: fixtures.docGrant });

    const after = await kit.db.runtime.db
      .select({
        status: documents.status,
        signRequestedAt: documents.signRequestedAt,
      })
      .from(documents)
      .where(eq(documents.id, fixtures.docGrant));
    expect(after[0]?.status).toBe("cancelled");
    expect(after[0]?.signRequestedAt).toBeNull();
  });

  it("rejects a missing idempotency key and a malformed documentId", async () => {
    await expect(
      kit.invoke(
        cancelDocument,
        { documentId: fixtures.docIdempotencyConflict },
        {},
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(cancelDocument, { documentId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("serializes concurrent cancels of the same issued document", async () => {
    const created = await kit.invoke(createFromOrder, {
      orderId: fixtures.orderConcurrent,
      type: "payment_invoice",
    });
    const results = await Promise.allSettled([
      kit.invoke(cancelDocument, { documentId: created.documentId }),
      kit.invoke(cancelDocument, { documentId: created.documentId }),
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
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, created.documentId));
    expect(row[0]?.status).toBe("cancelled");
  });
});
