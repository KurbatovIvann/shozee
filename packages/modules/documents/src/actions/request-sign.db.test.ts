import { randomUUID } from "node:crypto";

import {
  CONFIRMATION_TTL_MS,
  createConfirmationHook,
  createInMemoryConfirmationStore,
  defineEventHandler,
  eventEnvelopeSchema,
  implementAction,
  type ActionPipelineDeps,
  type ConfirmationHook,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import {
  ConfirmationRequiredError,
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
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import { signingSignatures } from "@showzy/db/schema/doc-signing";
import { documents } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { getArtifact } from "@showzy/doc-generation/get-artifact";
import { getSigning } from "@showzy/doc-signing/get";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  PDF_NOT_READY_MESSAGE,
  requestSign,
  requestSignConfirmationSummary,
} from "./request-sign.js";
import { documentsSignRequested } from "../events/sign-requested.js";

const payloadSha256 = "a".repeat(64);
const asicSha256 = "b".repeat(64);

const TEST_SIGN_REQUESTED_CONSUMER = "documents.test-sign-requested-noop";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderIdem: randomUUID(),
  orderConcurrent: randomUUID(),
  orderHappy: randomUUID(),
  orderCancelled: randomUUID(),
  orderSigned: randomUUID(),
  orderPdfPending: randomUUID(),
  orderEvent: randomUUID(),
  orderDeny: randomUUID(),
  itemIsolationA: randomUUID(),
  itemIsolationB: randomUUID(),
  itemIdem: randomUUID(),
  itemConcurrent: randomUUID(),
  itemHappy: randomUUID(),
  itemCancelled: randomUUID(),
  itemSigned: randomUUID(),
  itemPdfPending: randomUUID(),
  itemEvent: randomUUID(),
  itemDeny: randomUUID(),
  docIsolationA: randomUUID(),
  docIsolationB: randomUUID(),
  docIdem: randomUUID(),
  docConcurrent: randomUUID(),
  docHappy: randomUUID(),
  docCancelled: randomUUID(),
  docSigned: randomUUID(),
  docPdfPending: randomUUID(),
  docEvent: randomUUID(),
  docDeny: randomUUID(),
  pdfIsolationA: randomUUID(),
  pdfIsolationB: randomUUID(),
  pdfIdem: randomUUID(),
  pdfConcurrent: randomUUID(),
  pdfHappy: randomUUID(),
  pdfCancelled: randomUUID(),
  pdfSigned: randomUUID(),
  pdfEvent: randomUUID(),
  pdfDeny: randomUUID(),
  asicSigned: randomUUID(),
  signatureSigned: randomUUID(),
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

function autoConfirmHook(): ConfirmationHook {
  return {
    gate: () => {
      const confirmedAt = new Date();
      return Promise.resolve({
        challengeId: randomUUID(),
        confirmedAt,
        expiresAt: new Date(confirmedAt.getTime() + CONFIRMATION_TTL_MS),
      });
    },
  };
}

function attachAutoConfirm(target: TestKit): void {
  const hooks = target.pipeline.hooks;
  if (hooks === undefined) {
    throw new Error("test kit pipeline is missing protocol hooks");
  }
  Object.assign(hooks, { confirmation: autoConfirmHook() });
}

function confirmationPipeline(target: TestKit): ActionPipelineDeps {
  return {
    ...target.pipeline,
    hooks: {
      ...target.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
}

function nextSeedOrderNumber(companyId: string): string {
  const next = (seedOrderNumbers.get(companyId) ?? 0) + 1;
  seedOrderNumbers.set(companyId, next);
  return `T-${String(next)}`;
}

async function countGranted(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(eq(documents.companyId, companyId), eq(documents.status, "issued")),
    );
  let count = 0;
  for (const row of rows) {
    const header = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, row.id));
    if (header[0]?.signRequestedAt !== null) {
      count += 1;
    }
  }
  return count;
}

async function processedSignRequestedDeliveries(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ eventId: eventDeliveries.eventId })
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.consumer, TEST_SIGN_REQUESTED_CONSUMER),
        eq(eventDeliveries.status, "processed"),
      ),
    );
  return rows.length;
}

const emitSignRequestedThenFail = implementAction(
  defineActionContract({
    name: "documents.emitSignRequestedThenFail",
    description: "Test-local emit of documents.signRequested then fail.",
    principal: "staff",
    transport: "internal",
    input: z.strictObject({ documentId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["documents.signRequested"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(documentsSignRequested, {
        aggregate: { type: "document", id: input.documentId },
        payload: { documentId: input.documentId },
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

const projectSignRequestedTest = implementAction(
  defineActionContract({
    name: "documents.projectSignRequestedTest",
    description: "Test-local no-op consumer of documents.signRequested.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(documentsSignRequested.payload),
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
    auditTarget: () => ({ type: "document", id: "test-sign-requested-noop" }),
  },
);

const signRequestedNoop = defineEventHandler({
  event: documentsSignRequested,
  consumer: TEST_SIGN_REQUESTED_CONSUMER,
  action: projectSignRequestedTest,
});

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
  attachAutoConfirm(kit);
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;
  const createdAt = new Date("2026-08-30T12:00:00.000Z");

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
      number: "KA-РХ-000920",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfIsolationA,
    },
    {
      documentId: fixtures.docIsolationB,
      orderId: fixtures.orderIsolationB,
      orderItemId: fixtures.itemIsolationB,
      companyId: companyB,
      number: "MB-РХ-000920",
      orderNumber: nextSeedOrderNumber(companyB),
      status: "issued" as const,
      pdfId: fixtures.pdfIsolationB,
    },
    {
      documentId: fixtures.docIdem,
      orderId: fixtures.orderIdem,
      orderItemId: fixtures.itemIdem,
      companyId: companyA,
      number: "KA-РХ-000921",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfIdem,
    },
    {
      documentId: fixtures.docConcurrent,
      orderId: fixtures.orderConcurrent,
      orderItemId: fixtures.itemConcurrent,
      companyId: companyA,
      number: "KA-РХ-000922",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfConcurrent,
    },
    {
      documentId: fixtures.docHappy,
      orderId: fixtures.orderHappy,
      orderItemId: fixtures.itemHappy,
      companyId: companyA,
      number: "KA-РХ-000923",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfHappy,
    },
    {
      documentId: fixtures.docCancelled,
      orderId: fixtures.orderCancelled,
      orderItemId: fixtures.itemCancelled,
      companyId: companyA,
      number: "KA-РХ-000924",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "cancelled" as const,
      pdfId: fixtures.pdfCancelled,
    },
    {
      documentId: fixtures.docSigned,
      orderId: fixtures.orderSigned,
      orderItemId: fixtures.itemSigned,
      companyId: companyA,
      number: "KA-РХ-000925",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfSigned,
    },
    {
      documentId: fixtures.docPdfPending,
      orderId: fixtures.orderPdfPending,
      orderItemId: fixtures.itemPdfPending,
      companyId: companyA,
      number: "KA-РХ-000926",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: null,
    },
    {
      documentId: fixtures.docEvent,
      orderId: fixtures.orderEvent,
      orderItemId: fixtures.itemEvent,
      companyId: companyA,
      number: "KA-РХ-000927",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfEvent,
    },
    {
      documentId: fixtures.docDeny,
      orderId: fixtures.orderDeny,
      orderItemId: fixtures.itemDeny,
      companyId: companyA,
      number: "KA-РХ-000928",
      orderNumber: nextSeedOrderNumber(companyA),
      status: "issued" as const,
      pdfId: fixtures.pdfDeny,
    },
  ] as const;

  await kit.db.runtime.db.insert(orders).values(
    rows.map((row) => ({
      id: row.orderId,
      companyId: row.companyId,
      orderNumber: row.orderNumber,
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
      createdAt,
      updatedAt: createdAt,
    })),
  );

  for (const row of rows) {
    if (row.pdfId === null) {
      continue;
    }
    await insertDocumentFile(row.pdfId, row.companyId);
    await insertReadyJob(row.documentId, row.companyId, row.pdfId);
  }

  await kit.db.runtime.db.insert(files).values({
    id: fixtures.asicSigned,
    companyId: companyA,
    uploadedByUserId: kitIdentities.users.anna,
    purpose: "signing",
    mimeType: "application/vnd.etsi.asic-e+zip",
    byteSize: 2048n,
    objectKey: `${companyA}/signing/${fixtures.asicSigned}`,
    status: "ready",
    checksumSha256: asicSha256,
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
    signedAt: createdAt,
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.employee,
    name: "Employee",
    email: "employee@documents-request-sign-kit.test",
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
      requestSign,
      { input: { documentId: fixtures.docIsolationA } },
      { input: { documentId: fixtures.docIsolationB } },
    ),
    isolationCase(
      getSigning,
      { input: { documentId: fixtures.docIsolationA } },
      {
        companyId: kitIdentities.companies.b,
        input: { documentId: fixtures.docIsolationA },
      },
    ),
    isolationCase(
      getArtifact,
      { input: { documentId: fixtures.docIsolationA } },
      { input: { documentId: fixtures.docIsolationB } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: requestSign,
      input: { documentId: fixtures.docIdem },
      conflictingInput: { documentId: fixtures.docIsolationB },
      freshInput: () => ({ documentId: fixtures.docConcurrent }),
      readEffect: () => countGranted(kitIdentities.companies.a),
    },
  ],
);

eventSuite(() => kit, {
  module: "documents",
  emitAction: requestSign,
  emitInput: { documentId: fixtures.docEvent },
  failingEmitAction: emitSignRequestedThenFail,
  failingEmitInput: { documentId: randomUUID() },
  eventName: "documents.signRequested",
  subscription: signRequestedNoop,
  readProjection: processedSignRequestedDeliveries,
});

describe("documents.requestSign", () => {
  it("sets sign_requested_at, emits documents.signRequested, and records audit", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      requestSign,
      { documentId: fixtures.docHappy },
      {},
      { request: { requestId } },
    );
    expect(result).toEqual({ documentId: fixtures.docHappy });

    const header = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, fixtures.docHappy));
    expect(header[0]?.signRequestedAt).toBeInstanceOf(Date);

    const events = await kit.db.runtime.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(events.map((row) => row.name)).toEqual(["documents.signRequested"]);
    expect(events[0]?.payload).toEqual({ documentId: fixtures.docHappy });
    expect(events[0]?.aggregateType).toBe("document");

    const audits = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "documents.requestSign",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "document",
      targetId: fixtures.docHappy,
      outcome: "ok",
      inputSnapshot: null,
    });
  });

  it("rejects an unconfirmed call with a static summary and executes after the challenge", async () => {
    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        requestSign,
        { documentId: fixtures.docDeny },
        {},
        { deps, request: { idempotencyKey } },
      )
      .then(
        () => {
          throw new Error("expected ConfirmationRequiredError");
        },
        (error: unknown) => error,
      );

    expect(unconfirmed).toBeInstanceOf(ConfirmationRequiredError);
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw new Error("expected ConfirmationRequiredError");
    }
    expect(unconfirmed.challenge.summary).toBe(requestSignConfirmationSummary);
    expect(unconfirmed.challenge.summary).not.toContain("KA-РХ-000928");
    expect(unconfirmed.challenge.summary).not.toContain("Fixture buyer");
    expect(unconfirmed.challenge.summary).toContain("key possession");

    const before = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, fixtures.docDeny));
    expect(before[0]?.signRequestedAt).toBeNull();

    const confirmed = await kit.invoke(
      requestSign,
      { documentId: fixtures.docDeny },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    expect(confirmed).toEqual({ documentId: fixtures.docDeny });
    const after = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, fixtures.docDeny));
    expect(after[0]?.signRequestedAt).toBeInstanceOf(Date);
  });

  it("denies an employee with documents:view only", async () => {
    await expect(
      kit.invoke(
        requestSign,
        { documentId: fixtures.docHappy },
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
      .invoke(requestSign, { documentId: missingId })
      .catch((error: unknown) => error);
    const foreignError = await kit
      .invoke(requestSign, { documentId: fixtures.docIsolationB })
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

  it("conflicts on cancelled and already-signed documents", async () => {
    await expect(
      kit.invoke(requestSign, { documentId: fixtures.docCancelled }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === CANCELLED_REQUEST_SIGN_MESSAGE
      );
    });
    await expect(
      kit.invoke(requestSign, { documentId: fixtures.docSigned }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ConflictError &&
        error.clientMessage === ALREADY_SIGNED_MESSAGE
      );
    });
  });

  it("fails validation when the PDF is not ready", async () => {
    await expect(
      kit.invoke(requestSign, { documentId: fixtures.docPdfPending }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ValidationError &&
        error.clientMessage === PDF_NOT_READY_MESSAGE
      );
    });
  });

  it("rejects a malformed documentId and companyId on input", async () => {
    await expect(
      kit.invoke(requestSign, { documentId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(requestSign, {
        documentId: fixtures.docHappy,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
