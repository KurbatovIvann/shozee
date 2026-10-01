import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createCapturingLogger,
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
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import {
  documentItems,
  documents,
  documentShareTokens,
} from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAGE_TOKEN_TTL_MS } from "./share.contract.js";
import { shareDocument } from "./share.js";
import { configureDocumentShareOrigin } from "../services/share-origin.js";
import { hashDocumentShareToken } from "../services/token-hash.js";

const TEST_ORIGIN = "https://documents.test";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  docIsolationA: randomUUID(),
  docIsolationB: randomUUID(),
  docIdempotency: randomUUID(),
  docIdempotencyConflict: randomUUID(),
  docIdempotencyConcurrent: randomUUID(),
  docHappy: randomUUID(),
  docRotate: randomUUID(),
  docJob: randomUUID(),
  pendingFileId: randomUUID(),
};

const clerks = {
  noEdit: randomUUID(),
};

const sellerSnapshot = {
  kind: "seller" as const,
  name: "Konditerska Anna",
  prefix: "KA",
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
  edrpou: "12345678",
  legalAddress: "вул. Хрещатик, 1",
  iban: "UA123456789012345678901234567",
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
  customerId: string;
  productId: string;
  documentNumber: string;
}): Promise<void> {
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const itemId = randomUUID();
  await insertSeedOrder({
    id: orderId,
    itemId: orderItemId,
    companyId: values.companyId,
    customerId: values.customerId,
    productId: values.productId,
  });
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId,
    counterpartyId: null,
    type: "payment_invoice",
    status: "issued",
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
  await kit.db.runtime.db.insert(documentItems).values({
    id: itemId,
    companyId: values.companyId,
    documentId: values.id,
    productId: values.productId,
    titleSnapshot: "Invoice line",
    quantityMilli: 1000n,
    unitPriceMinor: 250n,
    taxTreatment: "exempt",
    netAmountMinor: 250n,
    grossAmountMinor: 250n,
    currency: "UAH",
  });
}

async function countShareTokens(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: documentShareTokens.id })
    .from(documentShareTokens)
    .where(eq(documentShareTokens.companyId, companyId));
  return rows.length;
}

async function readActiveToken(documentId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(documentShareTokens)
    .where(
      and(
        eq(documentShareTokens.documentId, documentId),
        isNull(documentShareTokens.revokedAt),
      ),
    );
  return rows[0];
}

beforeAll(async () => {
  configureDocumentShareOrigin(TEST_ORIGIN);
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

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

  await insertSeedDocument({
    id: fixtures.docIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000801",
  });
  await insertSeedDocument({
    id: fixtures.docIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
    documentNumber: "MB-РХ-000801",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotency,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000802",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotencyConflict,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000803",
  });
  await insertSeedDocument({
    id: fixtures.docIdempotencyConcurrent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000804",
  });
  await insertSeedDocument({
    id: fixtures.docHappy,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000805",
  });
  await insertSeedDocument({
    id: fixtures.docRotate,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000806",
  });
  await insertSeedDocument({
    id: fixtures.docJob,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-000807",
  });

  await kit.db.runtime.db.insert(files).values({
    id: fixtures.pendingFileId,
    companyId: companyA,
    uploadedByUserId: null,
    purpose: "document",
    objectKey: `${companyA}/documents/${fixtures.pendingFileId}`,
    mimeType: "application/pdf",
    byteSize: 0n,
    checksumSha256: null,
    status: "pending",
  });
  await kit.db.runtime.db.insert(documentGenerationJobs).values({
    companyId: companyA,
    documentId: fixtures.docJob,
    status: "ready",
    fileId: fixtures.pendingFileId,
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noEdit,
    name: "No edit",
    email: "noedit@documents-share-kit.test",
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
      shareDocument,
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
      action: shareDocument,
      input: { documentId: fixtures.docIdempotency },
      conflictingInput: { documentId: fixtures.docIdempotencyConflict },
      freshInput: () => ({ documentId: fixtures.docIdempotencyConcurrent }),
      readEffect: () => countShareTokens(kitIdentities.companies.a),
    },
  ],
);

describe("documents.share", () => {
  it("mints a page token once, stores only the hash, and persists null PDF fields when no artifact exists", async () => {
    const capturing = createCapturingLogger();
    const result = await kit.invoke(
      shareDocument,
      { documentId: fixtures.docHappy },
      {},
      { deps: { ...kit.pipeline, logger: capturing.logger } },
    );

    expect(result.documentId).toBe(fixtures.docHappy);
    expect(result.documentNumber).toBe("KA-РХ-000805");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.url).toBe(`${TEST_ORIGIN}/d/${result.token}`);
    expect(result.items).toHaveLength(1);

    const row = await readActiveToken(fixtures.docHappy);
    expect(row).toBeDefined();
    if (row === undefined) {
      throw new Error("expected an active share token");
    }
    expect(row.tokenHash).toBe(hashDocumentShareToken(result.token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.pdfDownloadUrl).toBeNull();
    expect(row.pdfDownloadExpiresAt).toBeNull();
    expect(row.signedDownloadUrl).toBeNull();
    expect(row.signedDownloadExpiresAt).toBeNull();
    expect(
      Math.abs(row.expiresAt.getTime() - (Date.now() + PAGE_TOKEN_TTL_MS)),
    ).toBeLessThan(10_000);

    const dbBlob = JSON.stringify(row);
    expect(dbBlob).not.toContain(result.token);
    const logBlob = JSON.stringify(capturing.entries());
    expect(logBlob).not.toContain(result.token);
    expect(logBlob).not.toContain(result.url);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "documents.share"));
    const thisAudit = auditRows.filter(
      (entry) => entry.targetId === fixtures.docHappy,
    );
    expect(thisAudit.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(thisAudit)).not.toContain(result.token);
    expect(JSON.stringify(thisAudit)).not.toContain(result.url);
    expect(thisAudit[0]?.inputSnapshot).toBeNull();
    expect(thisAudit[0]?.targetType).toBe("document");

    const shareEvents = await kit.db.runtime.db
      .select({ name: domainEvents.name })
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, fixtures.docHappy));
    expect(shareEvents.map((entry) => entry.name)).not.toContain(
      "documents.shared",
    );
  });

  it("rotates the active token on re-share", async () => {
    const first = await kit.invoke(shareDocument, {
      documentId: fixtures.docRotate,
    });
    const second = await kit.invoke(shareDocument, {
      documentId: fixtures.docRotate,
    });
    expect(second.token).not.toBe(first.token);
    expect(second.url).not.toBe(first.url);

    const rows = await kit.db.runtime.db
      .select()
      .from(documentShareTokens)
      .where(eq(documentShareTokens.documentId, fixtures.docRotate));
    expect(rows).toHaveLength(2);
    const revoked = rows.filter((row) => row.revokedAt !== null);
    const active = rows.filter((row) => row.revokedAt === null);
    expect(revoked).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(revoked[0]?.tokenHash).toBe(hashDocumentShareToken(first.token));
    expect(active[0]?.tokenHash).toBe(hashDocumentShareToken(second.token));
  });

  it("does not fail when a ready job points at a pending file — nested issuer not-found stores nulls", async () => {
    const capturing = createCapturingLogger();
    const result = await kit.invoke(
      shareDocument,
      { documentId: fixtures.docJob },
      {},
      { deps: { ...kit.pipeline, logger: capturing.logger } },
    );
    expect(result.documentId).toBe(fixtures.docJob);
    const row = await readActiveToken(fixtures.docJob);
    expect(row?.pdfDownloadUrl).toBeNull();
    expect(row?.pdfDownloadExpiresAt).toBeNull();
    expect(row?.signedDownloadUrl).toBeNull();
    expect(row?.signedDownloadExpiresAt).toBeNull();
    const actions = capturing
      .entries()
      .map((line) => line["action"])
      .filter((action) => typeof action === "string");
    expect(actions).toContain("files.issueShareDownloadUrl");
  });

  it("returns NotFound for missing and foreign-company documents without leaking existence", async () => {
    const missing = randomUUID();
    const missingDocument = await kit
      .invoke(shareDocument, { documentId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignDocument = await kit
      .invoke(shareDocument, { documentId: fixtures.docIsolationB })
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
        shareDocument,
        { documentId: fixtures.docHappy },
        {
          companyId: kitIdentities.companies.a,
          userId: clerks.noEdit,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects a malformed documentId", async () => {
    await expect(
      kit.invoke(shareDocument, { documentId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
