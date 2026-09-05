import { randomUUID } from "node:crypto";

import { implementAction } from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import { documentItems, documents } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SIGN_REQUEST_GRANT_TTL_MS,
  lockIssuedForSigningInputSchema,
  lockIssuedForSigningOutputSchema,
} from "./lock-issued-for-signing.contract.js";
import {
  GRANT_EXPIRED_MESSAGE,
  GRANT_MISSING_MESSAGE,
  lockIssuedForSigning,
} from "./lock-issued-for-signing.js";
import {
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
} from "./request-sign.js";

const payloadSha256 = "a".repeat(64);

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderHappy: randomUUID(),
  orderCancelled: randomUUID(),
  orderPdfPending: randomUUID(),
  orderGrantMissing: randomUUID(),
  orderGrantExpired: randomUUID(),
  orderDeny: randomUUID(),
  itemIsolationA: randomUUID(),
  itemIsolationB: randomUUID(),
  itemHappy: randomUUID(),
  itemCancelled: randomUUID(),
  itemPdfPending: randomUUID(),
  itemGrantMissing: randomUUID(),
  itemGrantExpired: randomUUID(),
  itemDeny: randomUUID(),
  docIsolationA: randomUUID(),
  docIsolationB: randomUUID(),
  docHappy: randomUUID(),
  docCancelled: randomUUID(),
  docPdfPending: randomUUID(),
  docGrantMissing: randomUUID(),
  docGrantExpired: randomUUID(),
  docDeny: randomUUID(),
  pdfIsolationA: randomUUID(),
  pdfIsolationB: randomUUID(),
  pdfHappy: randomUUID(),
  pdfCancelled: randomUUID(),
  pdfGrantMissing: randomUUID(),
  pdfGrantExpired: randomUUID(),
  pdfDeny: randomUUID(),
};

const clerks = {
  employee: randomUUID(),
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

const buyerSnapshot = {
  kind: "customer" as const,
  displayName: "Fixture buyer",
};

let kit: TestKit;
const seedOrderNumbers = new Map<string, number>();

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

/**
 * Root `risk: read` opens a read-only transaction, so `SELECT … FOR UPDATE`
 * cannot run as a transport root. Production always nests this lock from
 * `docSigning.start` (writable). This staff write wrapper is the same
 * nest: `ctx.call` of the real lock in the caller's write tx.
 */
const callLockIssuedForSigning = implementAction(
  defineActionContract({
    name: "lockTest.callIssuedForSigning",
    description:
      "Test-local staff write that nests documents.lockIssuedForSigning.",
    principal: "staff",
    transport: "internal",
    input: lockIssuedForSigningInputSchema,
    output: lockIssuedForSigningOutputSchema,
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 10_000,
  }),
  {
    handler: async (input, ctx) => {
      return ctx.call(lockIssuedForSigning, input);
    },
    auditTarget: (env) => {
      const parsed = lockIssuedForSigningInputSchema.safeParse(env.input);
      return {
        type: "document",
        id: parsed.success ? parsed.data.documentId : "unknown",
      };
    },
  },
);

async function insertDocumentFile(
  id: string,
  companyId: string,
): Promise<void> {
  await kit.db.runtime.db.insert(files).values({
    id,
    companyId,
    purpose: "document",
    mimeType: "application/pdf",
    byteSize: 1024n,
    objectKey: `${companyId}/documents/${id}`,
    status: "ready",
    checksumSha256: payloadSha256,
    stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
}

async function insertReadyJob(
  documentId: string,
  companyId: string,
  fileId: string,
): Promise<void> {
  await kit.db.runtime.db.insert(documentGenerationJobs).values({
    companyId,
    documentId,
    status: "ready",
    fileId,
  });
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;
  const createdAt = new Date("2026-08-30T12:00:00.000Z");
  const grantedAt = new Date();
  const expiredAt = new Date(Date.now() - SIGN_REQUEST_GRANT_TTL_MS - 60_000);

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

  const rows = [
    {
      documentId: fixtures.docIsolationA,
      orderId: fixtures.orderIsolationA,
      orderItemId: fixtures.itemIsolationA,
      companyId: companyA,
      number: "KA-РХ-000960",
      status: "issued" as const,
      pdfId: fixtures.pdfIsolationA,
      grant: grantedAt,
    },
    {
      documentId: fixtures.docIsolationB,
      orderId: fixtures.orderIsolationB,
      orderItemId: fixtures.itemIsolationB,
      companyId: companyB,
      number: "MB-РХ-000960",
      status: "issued" as const,
      pdfId: fixtures.pdfIsolationB,
      grant: grantedAt,
    },
    {
      documentId: fixtures.docHappy,
      orderId: fixtures.orderHappy,
      orderItemId: fixtures.itemHappy,
      companyId: companyA,
      number: "KA-РХ-000961",
      status: "issued" as const,
      pdfId: fixtures.pdfHappy,
      grant: grantedAt,
    },
    {
      documentId: fixtures.docCancelled,
      orderId: fixtures.orderCancelled,
      orderItemId: fixtures.itemCancelled,
      companyId: companyA,
      number: "KA-РХ-000962",
      status: "cancelled" as const,
      pdfId: fixtures.pdfCancelled,
      grant: grantedAt,
    },
    {
      documentId: fixtures.docPdfPending,
      orderId: fixtures.orderPdfPending,
      orderItemId: fixtures.itemPdfPending,
      companyId: companyA,
      number: "KA-РХ-000963",
      status: "issued" as const,
      pdfId: null,
      grant: grantedAt,
    },
    {
      documentId: fixtures.docGrantMissing,
      orderId: fixtures.orderGrantMissing,
      orderItemId: fixtures.itemGrantMissing,
      companyId: companyA,
      number: "KA-РХ-000964",
      status: "issued" as const,
      pdfId: fixtures.pdfGrantMissing,
      grant: null,
    },
    {
      documentId: fixtures.docGrantExpired,
      orderId: fixtures.orderGrantExpired,
      orderItemId: fixtures.itemGrantExpired,
      companyId: companyA,
      number: "KA-РХ-000965",
      status: "issued" as const,
      pdfId: fixtures.pdfGrantExpired,
      grant: expiredAt,
    },
    {
      documentId: fixtures.docDeny,
      orderId: fixtures.orderDeny,
      orderItemId: fixtures.itemDeny,
      companyId: companyA,
      number: "KA-РХ-000966",
      status: "issued" as const,
      pdfId: fixtures.pdfDeny,
      grant: grantedAt,
    },
  ] as const;

  await kit.db.runtime.db.insert(orders).values(
    rows.map((row) => ({
      id: row.orderId,
      companyId: row.companyId,
      orderNumber: nextSeedOrderNumber(row.companyId),
      customerId:
        row.companyId === companyA ? fixtures.customerA : fixtures.customerB,
      customerNameSnapshot: "Fixture customer",
      status: "new" as const,
      totalNetMinor: 250n,
      totalTaxMinor: 0n,
      totalGrossMinor: 250n,
      currency: "UAH",
    })),
  );
  await kit.db.runtime.db.insert(orderItems).values(
    rows.map((row) => ({
      id: row.orderItemId,
      companyId: row.companyId,
      orderId: row.orderId,
      productId:
        row.companyId === companyA ? fixtures.productA : fixtures.productB,
      titleSnapshot: "Seed",
      quantityMilli: 1000n,
      unitPriceMinor: 250n,
      taxTreatment: "exempt" as const,
      netAmountMinor: 250n,
      grossAmountMinor: 250n,
      priceSource: "base" as const,
      resolverVersion: 1,
    })),
  );
  await kit.db.runtime.db.insert(documents).values(
    rows.map((row) => ({
      id: row.documentId,
      companyId: row.companyId,
      orderId: row.orderId,
      counterpartyId: null,
      type: "payment_invoice",
      status: row.status,
      documentNumber: row.number,
      issuedOn: "2026-08-30",
      supplierDetails: sellerSnapshot,
      buyerDetails: buyerSnapshot,
      totalNetMinor: 250n,
      totalTaxMinor: 0n,
      totalGrossMinor: 250n,
      currency: "UAH",
      templateSource: "system",
      templateName: "payment_invoice",
      signRequestedAt: row.grant,
      createdAt,
      updatedAt: createdAt,
    })),
  );
  await kit.db.runtime.db.insert(documentItems).values(
    rows.map((row) => ({
      id: row.orderItemId,
      companyId: row.companyId,
      documentId: row.documentId,
      productId:
        row.companyId === companyA ? fixtures.productA : fixtures.productB,
      titleSnapshot: "Line",
      quantityMilli: 1000n,
      unitPriceMinor: 250n,
      taxTreatment: "exempt",
      netAmountMinor: 250n,
      grossAmountMinor: 250n,
      currency: "UAH",
      createdAt,
    })),
  );

  for (const row of rows) {
    if (row.pdfId === null) {
      continue;
    }
    await insertDocumentFile(row.pdfId, row.companyId);
    await insertReadyJob(row.documentId, row.companyId, row.pdfId);
  }

  await kit.db.runtime.db.insert(user).values({
    id: clerks.employee,
    name: "Employee",
    email: "employee@lock-issued-for-signing-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.employee,
    role: "employee",
    permissions: { granted: [], denied: [] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      callLockIssuedForSigning,
      { input: { documentId: fixtures.docIsolationA } },
      { input: { documentId: fixtures.docIsolationB } },
    ),
  ],
);

describe("documents.lockIssuedForSigning", () => {
  it("locks an issued granted PDF-ready document", async () => {
    const result = await kit.invoke(callLockIssuedForSigning, {
      documentId: fixtures.docHappy,
    });
    expect(result).toEqual({ documentId: fixtures.docHappy });
  });

  it("rejects a missing grant and an expired grant", async () => {
    const missing = await kit
      .invoke(callLockIssuedForSigning, {
        documentId: fixtures.docGrantMissing,
      })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ValidationError);
    if (missing instanceof ValidationError) {
      expect(missing.clientMessage).toBe(GRANT_MISSING_MESSAGE);
    }

    const expired = await kit
      .invoke(callLockIssuedForSigning, {
        documentId: fixtures.docGrantExpired,
      })
      .catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(ValidationError);
    if (expired instanceof ValidationError) {
      expect(expired.clientMessage).toBe(GRANT_EXPIRED_MESSAGE);
    }
  });

  it("rejects cancelled and PDF-not-ready documents", async () => {
    const cancelled = await kit
      .invoke(callLockIssuedForSigning, {
        documentId: fixtures.docCancelled,
      })
      .catch((error: unknown) => error);
    expect(cancelled).toBeInstanceOf(ConflictError);
    if (cancelled instanceof ConflictError) {
      expect(cancelled.clientMessage).toBe(CANCELLED_REQUEST_SIGN_MESSAGE);
    }

    const pdfPending = await kit
      .invoke(callLockIssuedForSigning, {
        documentId: fixtures.docPdfPending,
      })
      .catch((error: unknown) => error);
    expect(pdfPending).toBeInstanceOf(ValidationError);
    if (pdfPending instanceof ValidationError) {
      expect(pdfPending.clientMessage).toBe(PDF_NOT_READY_MESSAGE);
    }
  });

  it("denies documents:edit and an employee with documents:view only", async () => {
    await expect(
      kit.invoke(
        lockIssuedForSigning,
        { documentId: fixtures.docDeny },
        {
          userId: clerks.employee,
          companyId: kitIdentities.companies.a,
        },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the same not-found for missing and foreign documents", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(callLockIssuedForSigning, { documentId: missingId })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(callLockIssuedForSigning, {
        documentId: fixtures.docIsolationB,
      })
      .catch((error: unknown) => error);

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }
  });

  it("rejects companyId on input", async () => {
    await expect(
      kit.invoke(lockIssuedForSigning, {
        documentId: fixtures.docHappy,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
