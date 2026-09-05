import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import { implementAction } from "@showzy/core";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  eventSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog } from "@showzy/db";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { signingSignatures } from "@showzy/db/schema/doc-signing";
import {
  documentItems,
  documents,
  documentShareTokens,
} from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { docSigningRecorded } from "@showzy/doc-signing";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
} from "@showzy/files/storage";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { attachSignedShare } from "./attach-signed-share.js";
import {
  ATTACH_SIGNED_SHARE_EVENT_NAME,
  attachSignedShareInputSchema,
} from "./attach-signed-share.contract.js";
import { getShared } from "./get-shared.js";
import { shareDocument } from "./share.js";
import { signedShareAttacherRecorded } from "../events/signed-share-attacher.js";
import { configureDocumentShareOrigin } from "../services/share-origin.js";
import { hashDocumentShareToken } from "../services/token-hash.js";

const TEST_ORIGIN = "https://documents.test";
const asicSha256 = "b".repeat(64);
const UNSIGNED_PDF = "https://files.example/unsigned.pdf";

type RecordedEnvelope = z.input<typeof attachSignedShareInputSchema>;

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  docIsolationA: randomUUID(),
  docIsolationB: randomUUID(),
  docAfterShare: randomUUID(),
  docNoToken: randomUUID(),
  docRotate: randomUUID(),
  docExpire: randomUUID(),
  docEvent: randomUUID(),
  asicIsolationA: randomUUID(),
  asicAfterShare: randomUUID(),
  asicNoToken: randomUUID(),
  asicExpire: randomUUID(),
  asicEvent: randomUUID(),
  asicRotate: randomUUID(),
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

const emitRecordedThenFail = implementAction(
  defineActionContract({
    name: "docSigning.emitRecordedThenFailDocuments",
    description:
      "Test-local emitter that fails after buffering docSigning.recorded (chat golden: orders.emitCreatedThenFailChat).",
    principal: "staff",
    transport: "internal",
    input: z.object({ documentId: z.uuid(), fileId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["docSigning.recorded"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(docSigningRecorded, {
        aggregate: { type: "document", id: input.documentId },
        payload: {
          documentId: input.documentId,
          signerRole: "supplier",
          fileId: input.fileId,
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: (env) => {
      const parsed = z.object({ documentId: z.string() }).safeParse(env.input);
      return {
        type: "document",
        id: parsed.success ? parsed.data.documentId : "unknown",
      };
    },
  },
);

const emitRecorded = implementAction(
  defineActionContract({
    name: "docSigning.emitRecordedDocuments",
    description:
      "Test-local emitter of docSigning.recorded (chat golden: orders.emitCreatedThenFailChat).",
    principal: "staff",
    transport: "internal",
    input: z.object({ documentId: z.uuid(), fileId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["docSigning.recorded"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(docSigningRecorded, {
        aggregate: { type: "document", id: input.documentId },
        payload: {
          documentId: input.documentId,
          signerRole: "supplier",
          fileId: input.fileId,
        },
      });
      return Promise.resolve({ documentId: input.documentId });
    },
    auditTarget: (env) => {
      const parsed = z.object({ documentId: z.string() }).safeParse(env.input);
      return {
        type: "document",
        id: parsed.success ? parsed.data.documentId : "unknown",
      };
    },
  },
);

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

function recordedEnvelope(values: {
  readonly documentId: string;
  readonly fileId: string;
  readonly companyId: string;
}): RecordedEnvelope {
  const eventId = randomUUID();
  return {
    eventId,
    name: ATTACH_SIGNED_SHARE_EVENT_NAME,
    version: 1,
    occurredAt: new Date().toISOString(),
    companyId: values.companyId,
    aggregate: { type: "document", id: values.documentId, sequence: "1" },
    actor: { type: "user", id: kitIdentities.users.anna, channel: "ui" },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    causationId: eventId,
    payload: {
      documentId: values.documentId,
      signerRole: "supplier",
      fileId: values.fileId,
    },
  };
}

async function insertSeedDocument(values: {
  id: string;
  companyId: string;
  customerId: string;
  productId: string;
  documentNumber: string;
}): Promise<void> {
  const orderId = randomUUID();
  const unit = values.companyId === kitIdentities.companies.a ? 250n : 100n;
  await kit.db.runtime.db.insert(orders).values({
    id: orderId,
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
    id: randomUUID(),
    companyId: values.companyId,
    orderId,
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
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId,
    counterpartyId: null,
    type: "payment_invoice",
    status: "issued",
    documentNumber: values.documentNumber,
    issuedOn: "2026-08-30",
    supplierDetails: sellerSnapshot,
    buyerDetails: customerBuyerSnapshot,
    totalNetMinor: unit,
    totalTaxMinor: 0n,
    totalGrossMinor: unit,
    currency: "UAH",
    templateSource: "system",
    templateName: "payment_invoice",
  });
  await kit.db.runtime.db.insert(documentItems).values({
    id: randomUUID(),
    companyId: values.companyId,
    documentId: values.id,
    productId: values.productId,
    titleSnapshot: "Invoice line",
    quantityMilli: 1000n,
    unitPriceMinor: unit,
    taxTreatment: "exempt",
    netAmountMinor: unit,
    grossAmountMinor: unit,
    currency: "UAH",
  });
}

async function insertSigningFile(id: string, companyId: string): Promise<void> {
  await kit.db.runtime.db.insert(files).values({
    id,
    companyId,
    uploadedByUserId: kitIdentities.users.anna,
    purpose: "signing",
    mimeType: "application/vnd.etsi.asic-e+zip",
    byteSize: 2048n,
    objectKey: `${companyId}/signing/${id}`,
    status: "ready",
    checksumSha256: asicSha256,
    stagingPurgedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
}

async function insertSignature(values: {
  documentId: string;
  companyId: string;
  fileId: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(signingSignatures).values({
    companyId: values.companyId,
    documentId: values.documentId,
    signerRole: "supplier",
    fileId: values.fileId,
    signerCn: "ФОП Fixture",
    signerOrg: "Fixture Org",
    signerTaxId: "12345678",
    signatureAlg: "DSTU4145",
    signedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
}

async function insertActiveToken(values: {
  documentId: string;
  companyId: string;
  token: string;
  pdfDownloadUrl: string | null;
}): Promise<void> {
  const now = Date.now();
  await kit.db.runtime.db.insert(documentShareTokens).values({
    companyId: values.companyId,
    documentId: values.documentId,
    tokenHash: hashDocumentShareToken(values.token),
    expiresAt: new Date(now + 90 * 24 * 60 * 60 * 1000),
    pdfDownloadUrl: values.pdfDownloadUrl,
    pdfDownloadExpiresAt:
      values.pdfDownloadUrl === null ? null : new Date(now + 15 * 60 * 1000),
  });
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

async function countEventSignedTokens(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: documentShareTokens.id })
    .from(documentShareTokens)
    .where(
      and(
        eq(documentShareTokens.documentId, fixtures.docEvent),
        isNull(documentShareTokens.revokedAt),
        isNotNull(documentShareTokens.signedDownloadUrl),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  configureDocumentShareOrigin(TEST_ORIGIN);
  configureFilesObjectStore({
    endpoint: "http://127.0.0.1:9",
    region: "us-east-1",
    accessKeyId: "showzy-test",
    secretAccessKey: "showzy-test-secret",
    forcePathStyle: true,
    bucket: "showzy",
  });
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
    documentNumber: "KA-РХ-001001",
  });
  await insertSeedDocument({
    id: fixtures.docIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
    documentNumber: "MB-РХ-001001",
  });
  await insertSeedDocument({
    id: fixtures.docAfterShare,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-001002",
  });
  await insertSeedDocument({
    id: fixtures.docNoToken,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-001003",
  });
  await insertSeedDocument({
    id: fixtures.docRotate,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-001004",
  });
  await insertSeedDocument({
    id: fixtures.docExpire,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-001005",
  });
  await insertSeedDocument({
    id: fixtures.docEvent,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    documentNumber: "KA-РХ-001006",
  });

  await insertSigningFile(fixtures.asicIsolationA, companyA);
  await insertSigningFile(fixtures.asicAfterShare, companyA);
  await insertSigningFile(fixtures.asicNoToken, companyA);
  await insertSigningFile(fixtures.asicExpire, companyA);
  await insertSigningFile(fixtures.asicEvent, companyA);
  await insertSigningFile(fixtures.asicRotate, companyA);

  await insertSignature({
    documentId: fixtures.docNoToken,
    companyId: companyA,
    fileId: fixtures.asicNoToken,
  });
  await insertSignature({
    documentId: fixtures.docExpire,
    companyId: companyA,
    fileId: fixtures.asicExpire,
  });

  await insertActiveToken({
    documentId: fixtures.docIsolationA,
    companyId: companyA,
    token: "isolation-own-token",
    pdfDownloadUrl: UNSIGNED_PDF,
  });
  await insertActiveToken({
    documentId: fixtures.docEvent,
    companyId: companyA,
    token: "event-page-token",
    pdfDownloadUrl: UNSIGNED_PDF,
  });
});

afterAll(async () => {
  await kit.db.close();
  closeFilesObjectStore();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      attachSignedShare,
      {
        input: recordedEnvelope({
          documentId: fixtures.docIsolationA,
          fileId: fixtures.asicIsolationA,
          companyId: kitIdentities.companies.a,
        }),
      },
      {
        input: recordedEnvelope({
          documentId: fixtures.docIsolationB,
          fileId: fixtures.asicIsolationA,
          companyId: kitIdentities.companies.a,
        }),
      },
    ),
  ],
);

eventSuite(() => kit, {
  module: "documents",
  emitAction: emitRecorded,
  emitInput: {
    documentId: fixtures.docEvent,
    fileId: fixtures.asicEvent,
  },
  failingEmitAction: emitRecordedThenFail,
  failingEmitInput: { documentId: randomUUID(), fileId: randomUUID() },
  eventName: "docSigning.recorded",
  subscription: signedShareAttacherRecorded,
  readProjection: countEventSignedTokens,
});

describe("documents.attachSignedShare", () => {
  it("writes a signed URL onto the active token without rotating the page token", async () => {
    const shared = await kit.invoke(shareDocument, {
      documentId: fixtures.docAfterShare,
    });
    const before = await readActiveToken(fixtures.docAfterShare);
    expect(before).toBeDefined();
    if (before === undefined) {
      throw new Error("expected an active share token");
    }
    expect(before.signedDownloadUrl).toBeNull();
    await kit.db.runtime.db
      .update(documentShareTokens)
      .set({
        pdfDownloadUrl: UNSIGNED_PDF,
        pdfDownloadExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .where(eq(documentShareTokens.id, before.id));

    const capturing = createCapturingLogger();
    const result = await kit.invoke(
      attachSignedShare,
      recordedEnvelope({
        documentId: fixtures.docAfterShare,
        fileId: fixtures.asicAfterShare,
        companyId: kitIdentities.companies.a,
      }),
      {},
      { deps: { ...kit.pipeline, logger: capturing.logger } },
    );
    expect(result.documentId).toBe(fixtures.docAfterShare);

    const after = await readActiveToken(fixtures.docAfterShare);
    expect(after?.tokenHash).toBe(before.tokenHash);
    expect(after?.tokenHash).toBe(hashDocumentShareToken(shared.token));
    expect(after?.revokedAt).toBeNull();
    expect(after?.signedDownloadUrl).toEqual(expect.any(String));
    expect(after?.signedDownloadExpiresAt).toEqual(expect.any(Date));
    expect(after?.pdfDownloadUrl).toBe(UNSIGNED_PDF);
    expect(after?.signedDownloadUrl).not.toBe(UNSIGNED_PDF);

    const viewed = await kit.invoke(getShared, { token: shared.token });
    expect(viewed.documentId).toBe(fixtures.docAfterShare);
    expect(viewed.pdfDownloadUrl).toBe(UNSIGNED_PDF);
    expect(viewed.signedDownloadUrl).toBe(after?.signedDownloadUrl);

    const logBlob = JSON.stringify(capturing.entries());
    expect(logBlob).not.toContain(shared.token);
    expect(logBlob).not.toContain(after?.signedDownloadUrl ?? "missing-url");
    expect(logBlob).not.toMatch(/X-Amz-Signature/);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "documents.attachSignedShare"));
    const thisAudit = auditRows.filter(
      (entry) => entry.targetId === fixtures.docAfterShare,
    );
    expect(thisAudit.length).toBeGreaterThanOrEqual(1);
    expect(thisAudit[0]?.targetType).toBe("document");
    expect(JSON.stringify(thisAudit)).not.toContain(
      after?.signedDownloadUrl ?? "missing-url",
    );
  });

  it("no-ops when there is no active token so a later Share can mint both URLs", async () => {
    const beforeRows = await kit.db.runtime.db
      .select({ id: documentShareTokens.id })
      .from(documentShareTokens)
      .where(eq(documentShareTokens.documentId, fixtures.docNoToken));
    expect(beforeRows).toHaveLength(0);

    const result = await kit.invoke(
      attachSignedShare,
      recordedEnvelope({
        documentId: fixtures.docNoToken,
        fileId: fixtures.asicNoToken,
        companyId: kitIdentities.companies.a,
      }),
    );
    expect(result.documentId).toBe(fixtures.docNoToken);
    const afterAttach = await kit.db.runtime.db
      .select({ id: documentShareTokens.id })
      .from(documentShareTokens)
      .where(eq(documentShareTokens.documentId, fixtures.docNoToken));
    expect(afterAttach).toHaveLength(0);

    const shared = await kit.invoke(shareDocument, {
      documentId: fixtures.docNoToken,
    });
    const row = await readActiveToken(fixtures.docNoToken);
    expect(row).toBeDefined();
    expect(row?.tokenHash).toBe(hashDocumentShareToken(shared.token));
    expect(row?.pdfDownloadUrl).toBeNull();
    expect(row?.signedDownloadUrl).toEqual(expect.any(String));

    const viewed = await kit.invoke(getShared, { token: shared.token });
    expect(viewed.signedDownloadUrl).toBe(row?.signedDownloadUrl);
    expect(viewed.pdfDownloadUrl).toBeNull();
  });

  it("does not prevent human Share from rotating the page token", async () => {
    const first = await kit.invoke(shareDocument, {
      documentId: fixtures.docRotate,
    });
    await kit.invoke(
      attachSignedShare,
      recordedEnvelope({
        documentId: fixtures.docRotate,
        fileId: fixtures.asicRotate,
        companyId: kitIdentities.companies.a,
      }),
    );
    const afterAttach = await kit.invoke(getShared, { token: first.token });
    expect(afterAttach.documentId).toBe(fixtures.docRotate);
    expect(afterAttach.signedDownloadUrl).toEqual(expect.any(String));

    const second = await kit.invoke(shareDocument, {
      documentId: fixtures.docRotate,
    });
    expect(second.token).not.toBe(first.token);
    await expect(
      kit.invoke(getShared, { token: first.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const viewed = await kit.invoke(getShared, { token: second.token });
    expect(viewed.documentId).toBe(fixtures.docRotate);
  });

  it("returns null signedDownloadUrl when the stored signature expired and remints via Share", async () => {
    const first = await kit.invoke(shareDocument, {
      documentId: fixtures.docExpire,
    });
    const active = await readActiveToken(fixtures.docExpire);
    expect(active?.signedDownloadUrl).toEqual(expect.any(String));
    await kit.db.runtime.db
      .update(documentShareTokens)
      .set({ signedDownloadExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(documentShareTokens.id, active?.id ?? randomUUID()));

    const expiredView = await kit.invoke(getShared, { token: first.token });
    expect(expiredView.documentId).toBe(fixtures.docExpire);
    expect(expiredView.signedDownloadUrl).toBeNull();

    const reminted = await kit.invoke(shareDocument, {
      documentId: fixtures.docExpire,
    });
    expect(reminted.token).not.toBe(first.token);
    await expect(
      kit.invoke(getShared, { token: first.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const remintedView = await kit.invoke(getShared, {
      token: reminted.token,
    });
    expect(remintedView.signedDownloadUrl).toEqual(expect.any(String));
  });

  it("returns NotFound for missing and foreign-company documents without leaking existence", async () => {
    const missing = randomUUID();
    const missingDocument = await kit
      .invoke(
        attachSignedShare,
        recordedEnvelope({
          documentId: missing,
          fileId: fixtures.asicAfterShare,
          companyId: kitIdentities.companies.a,
        }),
      )
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignDocument = await kit
      .invoke(
        attachSignedShare,
        recordedEnvelope({
          documentId: fixtures.docIsolationB,
          fileId: fixtures.asicAfterShare,
          companyId: kitIdentities.companies.a,
        }),
      )
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

  it("rejects a malformed envelope", async () => {
    await expect(
      kit.invoke(attachSignedShare, {
        ...recordedEnvelope({
          documentId: fixtures.docAfterShare,
          fileId: fixtures.asicAfterShare,
          companyId: kitIdentities.companies.a,
        }),
        payload: {
          documentId: "not-a-uuid",
          signerRole: "supplier",
          fileId: fixtures.asicAfterShare,
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
