import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import { implementAction } from "@showzy/core";
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
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  signingRequests,
  signingSignatures,
} from "@showzy/db/schema/doc-signing";
import { documentItems, documents } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { cancelDocument, documentsCancelled } from "@showzy/documents";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { abandonRequest } from "./abandon-request.js";
import {
  ABANDON_REQUEST_EVENT_NAME,
  abandonRequestInputSchema,
} from "./abandon-request.contract.js";
import { getSigning } from "./get.js";
import { getSupplierSignedFlags } from "./get-supplier-signed-flags.js";
import { SUPPLIER_SIGNED_FLAGS_MAX_IDS } from "./get-supplier-signed-flags.contract.js";
import { requestAbandonerCancelled } from "../events/request-abandoner.js";

const payloadSha256 = "a".repeat(64);
const asicSha256 = "b".repeat(64);

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderUnsignedA: randomUUID(),
  orderPendingA: randomUUID(),
  orderSignedA: randomUUID(),
  orderEvent: randomUUID(),
  orderKeep: randomUUID(),
  orderIsolationAbandon: randomUUID(),
  orderForeign: randomUUID(),
  orderForeignPending: randomUUID(),
  orderItemUnsignedA: randomUUID(),
  orderItemPendingA: randomUUID(),
  orderItemSignedA: randomUUID(),
  orderItemEvent: randomUUID(),
  orderItemKeep: randomUUID(),
  orderItemIsolationAbandon: randomUUID(),
  orderItemForeign: randomUUID(),
  orderItemForeignPending: randomUUID(),
  docUnsignedA: randomUUID(),
  docPendingA: randomUUID(),
  docSignedA: randomUUID(),
  docEvent: randomUUID(),
  docKeepSignature: randomUUID(),
  docIsolationAbandon: randomUUID(),
  docForeign: randomUUID(),
  docForeignPending: randomUUID(),
  itemUnsignedA: randomUUID(),
  itemPendingA: randomUUID(),
  itemSignedA: randomUUID(),
  itemEvent: randomUUID(),
  itemKeepSignature: randomUUID(),
  itemIsolationAbandon: randomUUID(),
  itemForeign: randomUUID(),
  itemForeignPending: randomUUID(),
  payloadUnsigned: randomUUID(),
  payloadPending: randomUUID(),
  payloadSigned: randomUUID(),
  payloadEvent: randomUUID(),
  payloadKeep: randomUUID(),
  payloadIsolationAbandon: randomUUID(),
  payloadForeign: randomUUID(),
  payloadForeignPending: randomUUID(),
  asicSigned: randomUUID(),
  asicKeep: randomUUID(),
  requestPending: randomUUID(),
  requestEvent: randomUUID(),
  requestKeepCompleted: randomUUID(),
  requestIsolationAbandon: randomUUID(),
  requestForeignPending: randomUUID(),
  signatureSigned: randomUUID(),
  signatureKeep: randomUUID(),
};

const clerks = {
  noView: randomUUID(),
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

type AbandonEnvelope = z.input<typeof abandonRequestInputSchema>;

function abandonEnvelope(values: {
  readonly documentId: string;
  readonly orderId: string;
  readonly companyId: string;
}): AbandonEnvelope {
  const eventId = randomUUID();
  return {
    eventId,
    name: ABANDON_REQUEST_EVENT_NAME,
    version: 1,
    occurredAt: new Date().toISOString(),
    companyId: values.companyId,
    aggregate: { type: "document", id: values.documentId, sequence: "1" },
    actor: { type: "user", id: kitIdentities.users.anna, channel: "ui" },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    causationId: eventId,
    payload: { documentId: values.documentId, orderId: values.orderId },
  };
}

const emitCancelledThenFail = implementAction(
  defineActionContract({
    name: "documents.emitCancelledThenFailSigning",
    description:
      "Test-local emitter that fails after buffering documents.cancelled.",
    principal: "staff",
    transport: "internal",
    input: z.object({ documentId: z.uuid() }),
    output: z.object({ documentId: z.uuid() }),
    permissions: ["documents:edit"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["documents.cancelled"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(documentsCancelled, {
        aggregate: { type: "document", id: input.documentId },
        payload: {
          documentId: input.documentId,
          orderId: fixtures.orderEvent,
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

async function countCancelledWithoutPending(): Promise<number> {
  const cancelled = await kit.db.runtime.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, kitIdentities.companies.a),
        eq(documents.status, "cancelled"),
      ),
    );
  let count = 0;
  for (const row of cancelled) {
    const pending = await kit.db.runtime.db
      .select({ id: signingRequests.id })
      .from(signingRequests)
      .where(
        and(
          eq(signingRequests.companyId, kitIdentities.companies.a),
          eq(signingRequests.documentId, row.id),
          eq(signingRequests.status, "pending"),
        ),
      );
    if (pending.length === 0) {
      count += 1;
    }
  }
  return count;
}

beforeAll(async () => {
  kit = await createTestKit();
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
      documentId: fixtures.docUnsignedA,
      orderId: fixtures.orderUnsignedA,
      orderItemId: fixtures.orderItemUnsignedA,
      itemId: fixtures.itemUnsignedA,
      companyId: companyA,
      number: "KA-РХ-000010",
      orderNumber: "T-1",
    },
    {
      documentId: fixtures.docPendingA,
      orderId: fixtures.orderPendingA,
      orderItemId: fixtures.orderItemPendingA,
      itemId: fixtures.itemPendingA,
      companyId: companyA,
      number: "KA-РХ-000011",
      orderNumber: "T-2",
    },
    {
      documentId: fixtures.docSignedA,
      orderId: fixtures.orderSignedA,
      orderItemId: fixtures.orderItemSignedA,
      itemId: fixtures.itemSignedA,
      companyId: companyA,
      number: "KA-РХ-000012",
      orderNumber: "T-3",
    },
    {
      documentId: fixtures.docEvent,
      orderId: fixtures.orderEvent,
      orderItemId: fixtures.orderItemEvent,
      itemId: fixtures.itemEvent,
      companyId: companyA,
      number: "KA-РХ-000013",
      orderNumber: "T-4",
    },
    {
      documentId: fixtures.docKeepSignature,
      orderId: fixtures.orderKeep,
      orderItemId: fixtures.orderItemKeep,
      itemId: fixtures.itemKeepSignature,
      companyId: companyA,
      number: "KA-РХ-000014",
      orderNumber: "T-5",
    },
    {
      documentId: fixtures.docIsolationAbandon,
      orderId: fixtures.orderIsolationAbandon,
      orderItemId: fixtures.orderItemIsolationAbandon,
      itemId: fixtures.itemIsolationAbandon,
      companyId: companyA,
      number: "KA-РХ-000015",
      orderNumber: "T-6",
    },
    {
      documentId: fixtures.docForeign,
      orderId: fixtures.orderForeign,
      orderItemId: fixtures.orderItemForeign,
      itemId: fixtures.itemForeign,
      companyId: companyB,
      number: "MB-РХ-000010",
      orderNumber: "T-1",
    },
    {
      documentId: fixtures.docForeignPending,
      orderId: fixtures.orderForeignPending,
      orderItemId: fixtures.orderItemForeignPending,
      itemId: fixtures.itemForeignPending,
      companyId: companyB,
      number: "MB-РХ-000011",
      orderNumber: "T-2",
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
      totalNetMinor: row.companyId === companyA ? 250n : 100n,
      totalTaxMinor: 0n,
      totalGrossMinor: row.companyId === companyA ? 250n : 100n,
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
      unitPriceMinor: row.companyId === companyA ? 250n : 100n,
      taxTreatment: "exempt" as const,
      netAmountMinor: row.companyId === companyA ? 250n : 100n,
      grossAmountMinor: row.companyId === companyA ? 250n : 100n,
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
      status: "issued",
      documentNumber: row.number,
      issuedOn: "2026-08-30",
      supplierDetails: sellerSnapshot,
      buyerDetails: buyerSnapshot,
      totalNetMinor: row.companyId === companyA ? 250n : 100n,
      totalTaxMinor: 0n,
      totalGrossMinor: row.companyId === companyA ? 250n : 100n,
      currency: "UAH",
      templateSource: "system",
      templateName: "payment_invoice",
      createdAt,
      updatedAt: createdAt,
    })),
  );
  await kit.db.runtime.db.insert(documentItems).values(
    rows.map((row) => ({
      id: row.itemId,
      companyId: row.companyId,
      documentId: row.documentId,
      productId:
        row.companyId === companyA ? fixtures.productA : fixtures.productB,
      titleSnapshot: "Line",
      quantityMilli: 1000n,
      unitPriceMinor: row.companyId === companyA ? 250n : 100n,
      taxTreatment: "exempt",
      netAmountMinor: row.companyId === companyA ? 250n : 100n,
      grossAmountMinor: row.companyId === companyA ? 250n : 100n,
      currency: "UAH",
      createdAt,
    })),
  );

  await insertDocumentFile(fixtures.payloadUnsigned, companyA);
  await insertDocumentFile(fixtures.payloadPending, companyA);
  await insertDocumentFile(fixtures.payloadSigned, companyA);
  await insertDocumentFile(fixtures.payloadEvent, companyA);
  await insertDocumentFile(fixtures.payloadKeep, companyA);
  await insertDocumentFile(fixtures.payloadIsolationAbandon, companyA);
  await insertDocumentFile(fixtures.payloadForeign, companyB);
  await insertDocumentFile(fixtures.payloadForeignPending, companyB);
  await insertSigningFile(fixtures.asicSigned, companyA);
  await insertSigningFile(fixtures.asicKeep, companyA);

  await kit.db.runtime.db.insert(signingRequests).values([
    {
      id: fixtures.requestPending,
      companyId: companyA,
      documentId: fixtures.docPendingA,
      payloadFileId: fixtures.payloadPending,
      payloadSha256,
      status: "pending",
    },
    {
      id: fixtures.requestEvent,
      companyId: companyA,
      documentId: fixtures.docEvent,
      payloadFileId: fixtures.payloadEvent,
      payloadSha256,
      status: "pending",
    },
    {
      id: fixtures.requestKeepCompleted,
      companyId: companyA,
      documentId: fixtures.docKeepSignature,
      payloadFileId: fixtures.payloadKeep,
      payloadSha256,
      status: "completed",
    },
    {
      id: fixtures.requestIsolationAbandon,
      companyId: companyA,
      documentId: fixtures.docIsolationAbandon,
      payloadFileId: fixtures.payloadIsolationAbandon,
      payloadSha256,
      status: "pending",
    },
    {
      id: fixtures.requestForeignPending,
      companyId: companyB,
      documentId: fixtures.docForeignPending,
      payloadFileId: fixtures.payloadForeignPending,
      payloadSha256,
      status: "pending",
    },
  ]);

  await kit.db.runtime.db.insert(signingSignatures).values([
    {
      id: fixtures.signatureSigned,
      companyId: companyA,
      documentId: fixtures.docSignedA,
      signerRole: "supplier",
      fileId: fixtures.asicSigned,
      signerCn: "ФОП Fixture",
      signerOrg: "Fixture Org",
      signerTaxId: "12345678",
      signatureAlg: "DSTU4145",
      signedAt: createdAt,
    },
    {
      id: fixtures.signatureKeep,
      companyId: companyA,
      documentId: fixtures.docKeepSignature,
      signerRole: "supplier",
      fileId: fixtures.asicKeep,
      signerCn: "ФОП Fixture",
      signerOrg: "Fixture Org",
      signerTaxId: "12345678",
      signatureAlg: "DSTU4145",
      signedAt: createdAt,
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerks.noView,
    name: "No view",
    email: "noview@doc-signing-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.noView,
    role: "employee",
    permissions: { granted: [], denied: ["documents:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      getSigning,
      { input: { documentId: fixtures.docUnsignedA } },
      {
        companyId: kitIdentities.companies.b,
        input: { documentId: fixtures.docUnsignedA },
      },
    ),
    isolationCase(
      getSupplierSignedFlags,
      { input: { documentIds: [fixtures.docSignedA] } },
      {
        companyId: kitIdentities.companies.b,
        input: { documentIds: [fixtures.docSignedA] },
      },
    ),
    isolationCase(
      abandonRequest,
      {
        input: abandonEnvelope({
          documentId: fixtures.docIsolationAbandon,
          orderId: fixtures.orderIsolationAbandon,
          companyId: kitIdentities.companies.a,
        }),
      },
      {
        input: abandonEnvelope({
          documentId: fixtures.docForeignPending,
          orderId: fixtures.orderForeignPending,
          companyId: kitIdentities.companies.a,
        }),
      },
    ),
  ],
);

eventSuite(() => kit, {
  module: "docSigning",
  emitAction: cancelDocument,
  emitInput: { documentId: fixtures.docEvent },
  failingEmitAction: emitCancelledThenFail,
  failingEmitInput: { documentId: randomUUID() },
  eventName: "documents.cancelled",
  subscription: requestAbandonerCancelled,
  readProjection: countCancelledWithoutPending,
});

describe("docSigning.get / getSupplierSignedFlags / abandonRequest", () => {
  it("returns unsigned, pending, and supplier_signed from own tables", async () => {
    expect(
      await kit.invoke(getSigning, { documentId: fixtures.docUnsignedA }),
    ).toEqual({ status: "unsigned" });
    expect(
      await kit.invoke(getSigning, { documentId: fixtures.docPendingA }),
    ).toEqual({
      status: "pending",
      requestId: fixtures.requestPending,
    });
    expect(
      await kit.invoke(getSigning, { documentId: fixtures.docSignedA }),
    ).toEqual({
      status: "supplier_signed",
      signedFileId: fixtures.asicSigned,
    });
  });

  it("reports unsigned for missing and foreign ids without leaking existence or signed files", async () => {
    const missingId = randomUUID();
    expect(await kit.invoke(getSigning, { documentId: missingId })).toEqual({
      status: "unsigned",
    });
    expect(
      await kit.invoke(getSigning, { documentId: fixtures.docForeign }),
    ).toEqual({ status: "unsigned" });
    expect(
      await kit.invoke(getSigning, { documentId: fixtures.docForeignPending }),
    ).toEqual({ status: "unsigned" });
  });

  it("denies staff without documents:view", async () => {
    await expect(
      kit.invoke(
        getSigning,
        { documentId: fixtures.docUnsignedA },
        { userId: clerks.noView, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(
        getSupplierSignedFlags,
        { documentIds: [fixtures.docSignedA] },
        { userId: clerks.noView, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects malformed ids and companyId on the client get", async () => {
    await expect(
      kit.invoke(getSigning, { documentId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(getSigning, {
        documentId: fixtures.docUnsignedA,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns flags in first-seen unique order without N+1 or existence leaks", async () => {
    const empty = await kit.invoke(getSupplierSignedFlags, { documentIds: [] });
    expect(empty).toEqual({ flags: [] });

    const missingId = randomUUID();
    const result = await kit.invoke(getSupplierSignedFlags, {
      documentIds: [
        fixtures.docUnsignedA,
        fixtures.docSignedA,
        fixtures.docUnsignedA,
        fixtures.docForeign,
        missingId,
      ],
    });
    expect(result).toEqual({
      flags: [
        { documentId: fixtures.docUnsignedA, supplierSigned: false },
        { documentId: fixtures.docSignedA, supplierSigned: true },
        { documentId: fixtures.docForeign, supplierSigned: false },
        { documentId: missingId, supplierSigned: false },
      ],
    });

    await expect(
      kit.invoke(getSupplierSignedFlags, {
        documentIds: Array.from(
          { length: SUPPLIER_SIGNED_FLAGS_MAX_IDS + 1 },
          () => randomUUID(),
        ),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("drops a pending request on cancelled delivery and leaves completed signatures", async () => {
    const pendingBefore = await kit.db.runtime.db
      .select({ id: signingRequests.id })
      .from(signingRequests)
      .where(eq(signingRequests.id, fixtures.requestPending));
    expect(pendingBefore).toHaveLength(1);

    const dropped = await kit.invoke(
      abandonRequest,
      abandonEnvelope({
        documentId: fixtures.docPendingA,
        orderId: fixtures.orderPendingA,
        companyId: kitIdentities.companies.b,
      }),
    );
    expect(dropped).toEqual({ documentId: fixtures.docPendingA });
    expect(
      await kit.db.runtime.db
        .select({ id: signingRequests.id })
        .from(signingRequests)
        .where(eq(signingRequests.id, fixtures.requestPending)),
    ).toEqual([]);

    const replay = await kit.invoke(
      abandonRequest,
      abandonEnvelope({
        documentId: fixtures.docPendingA,
        orderId: fixtures.orderPendingA,
        companyId: kitIdentities.companies.a,
      }),
    );
    expect(replay).toEqual({ documentId: fixtures.docPendingA });

    const kept = await kit.invoke(
      abandonRequest,
      abandonEnvelope({
        documentId: fixtures.docKeepSignature,
        orderId: fixtures.orderKeep,
        companyId: kitIdentities.companies.a,
      }),
    );
    expect(kept).toEqual({ documentId: fixtures.docKeepSignature });
    expect(
      await kit.db.runtime.db
        .select({ id: signingSignatures.id })
        .from(signingSignatures)
        .where(eq(signingSignatures.id, fixtures.signatureKeep)),
    ).toHaveLength(1);
    expect(
      await kit.db.runtime.db
        .select({ id: signingRequests.id, status: signingRequests.status })
        .from(signingRequests)
        .where(eq(signingRequests.id, fixtures.requestKeepCompleted)),
    ).toEqual([{ id: fixtures.requestKeepCompleted, status: "completed" }]);

    const audits = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "docSigning.abandonRequest"),
          eq(auditLog.targetId, fixtures.docPendingA),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]?.companyId).toBe(kitIdentities.companies.a);
    expect(audits[0]?.targetType).toBe("document");
  });

  it("does not treat envelope companyId as a tenant grant", async () => {
    await expect(
      kit.invoke(
        abandonRequest,
        abandonEnvelope({
          documentId: fixtures.docForeignPending,
          orderId: fixtures.orderForeignPending,
          companyId: kitIdentities.companies.b,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await kit.db.runtime.db
        .select({ id: signingRequests.id })
        .from(signingRequests)
        .where(eq(signingRequests.id, fixtures.requestForeignPending)),
    ).toHaveLength(1);
  });
});
