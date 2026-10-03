import { randomUUID } from "node:crypto";

import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
} from "@showzy/core";
import {
  ConfirmationRequiredError,
  ConflictError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog } from "@showzy/db";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { documentGenerationJobs } from "@showzy/db/schema/doc-generation";
import { documents, documentShareTokens } from "@showzy/db/schema/documents";
import { files } from "@showzy/db/schema/files";
import { orders } from "@showzy/db/schema/orders";
import {
  ENTITY_LOOKUP_OPTIONS_MAX,
  EntityLookupAmbiguousError,
  EntityLookupUnmatchedError,
} from "@showzy/module-kit/entity-lookup";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cancelDocument } from "./cancel.js";
import { requestSign, requestSignPreviewTitle } from "./request-sign.js";
import { shareDocument } from "./share.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const asCompanyB = {
  userId: kitIdentities.users.boris,
  companyId: companyB,
};

const INVOICE_57 = "KA-РХ-000057";
const DELIVERY_57 = "KA-ВН-000057";
const SPOKEN_NUMBER = "KA-РХ-000131";
const CASED_NUMBER = "KA-РХ-000132";
const SIBLING_ONE = "KA-РХ-000800";
const SIBLING_TWO = "KA-РХ-000801";
const SHARED_NUMBER = "KA-РХ-000200";
const SIGNABLE_NUMBER = "KA-РХ-000300";
const IDEMPOTENT_NUMBER = "KA-РХ-000400";
const FOREIGN_NUMBER = "MB-РХ-000131";

const overCap = Array.from(
  { length: ENTITY_LOOKUP_OPTIONS_MAX + 1 },
  (_unused, index) => ({
    id: randomUUID(),
    documentNumber: `KA-РХ-0009${String(index).padStart(2, "0")}`,
  }),
);

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  byId: randomUUID(),
  invoice57: randomUUID(),
  delivery57: randomUUID(),
  spoken: randomUUID(),
  cased: randomUUID(),
  siblingOne: randomUUID(),
  siblingTwo: randomUUID(),
  shared: randomUUID(),
  signable: randomUUID(),
  idempotent: randomUUID(),
  signablePdf: randomUUID(),
  foreign: randomUUID(),
  auditConflict: randomUUID(),
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
  displayName: "Customer A",
};

let kit: TestKit;
let seedOrders = 0;

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

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
}

async function insertSeedDocument(values: {
  readonly id: string;
  readonly companyId: string;
  readonly documentNumber: string;
  readonly type?: "payment_invoice" | "delivery_note";
}): Promise<void> {
  seedOrders += 1;
  const orderId = randomUUID();
  await kit.db.runtime.db.insert(orders).values({
    id: orderId,
    companyId: values.companyId,
    orderNumber: `R-${String(seedOrders)}`,
    customerId:
      values.companyId === companyA ? fixtures.customerA : fixtures.customerB,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: 250n,
    totalTaxMinor: 0n,
    totalGrossMinor: 250n,
    currency: "UAH",
  });
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId,
    counterpartyId: null,
    type: values.type ?? "payment_invoice",
    status: "issued",
    documentNumber: values.documentNumber,
    issuedOn: "2026-03-15",
    supplierDetails: sellerSnapshot,
    buyerDetails: buyerSnapshot,
    totalNetMinor: 250n,
    totalTaxMinor: 0n,
    totalGrossMinor: 250n,
    currency: "UAH",
    templateSource: "system",
    templateName: "payment_invoice",
  });
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: "Customer A",
      email: `customer-${fixtures.customerA}@example.test`,
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: "Customer B",
      email: `customer-${fixtures.customerB}@example.test`,
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
      basePriceMinor: 250n,
    },
  ]);

  await insertSeedDocument({
    id: fixtures.byId,
    companyId: companyA,
    documentNumber: "KA-РХ-000001",
  });
  await insertSeedDocument({
    id: fixtures.invoice57,
    companyId: companyA,
    documentNumber: INVOICE_57,
  });
  await insertSeedDocument({
    id: fixtures.delivery57,
    companyId: companyA,
    documentNumber: DELIVERY_57,
    type: "delivery_note",
  });
  await insertSeedDocument({
    id: fixtures.spoken,
    companyId: companyA,
    documentNumber: SPOKEN_NUMBER,
  });
  await insertSeedDocument({
    id: fixtures.cased,
    companyId: companyA,
    documentNumber: CASED_NUMBER,
  });
  await insertSeedDocument({
    id: fixtures.siblingOne,
    companyId: companyA,
    documentNumber: SIBLING_ONE,
  });
  await insertSeedDocument({
    id: fixtures.siblingTwo,
    companyId: companyA,
    documentNumber: SIBLING_TWO,
  });
  await insertSeedDocument({
    id: fixtures.shared,
    companyId: companyA,
    documentNumber: SHARED_NUMBER,
  });
  await insertSeedDocument({
    id: fixtures.signable,
    companyId: companyA,
    documentNumber: SIGNABLE_NUMBER,
  });
  await insertSeedDocument({
    id: fixtures.idempotent,
    companyId: companyA,
    documentNumber: IDEMPOTENT_NUMBER,
  });
  for (const row of overCap) {
    await insertSeedDocument({
      id: row.id,
      companyId: companyA,
      documentNumber: row.documentNumber,
    });
  }
  await insertSeedDocument({
    id: fixtures.auditConflict,
    companyId: companyA,
    documentNumber: "KA-РХ-000500",
  });
  await insertSeedDocument({
    id: fixtures.foreign,
    companyId: companyB,
    documentNumber: FOREIGN_NUMBER,
  });

  await kit.db.runtime.db.insert(files).values({
    id: fixtures.signablePdf,
    companyId: companyA,
    purpose: "document",
    mimeType: "application/pdf",
    byteSize: 1024n,
    objectKey: `${companyA}/documents/${fixtures.signablePdf}`,
    status: "ready",
    checksumSha256: "a".repeat(64),
    stagingPurgedAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  await kit.db.runtime.db.insert(documentGenerationJobs).values({
    companyId: companyA,
    documentId: fixtures.signable,
    status: "ready",
    fileId: fixtures.signablePdf,
  });
});

afterAll(async () => {
  await kit.db.close();
});

describe("documents writes take an id or a document number (SHO-869)", () => {
  it("cancels by canonical id exactly as before", async () => {
    expect(
      await kit.invoke(cancelDocument, { documentId: fixtures.byId }),
    ).toMatchObject({ documentId: fixtures.byId, status: "cancelled" });
  });

  it("cancels the document named by the bare spoken sequence", async () => {
    expect(
      await kit.invoke(cancelDocument, { documentNumber: "131" }),
    ).toMatchObject({ documentId: fixtures.spoken, status: "cancelled" });
  });

  it("cancels by the canonical number whatever its hash and case", async () => {
    expect(
      await kit.invoke(cancelDocument, { documentNumber: "#ka-рх-000132" }),
    ).toMatchObject({ documentId: fixtures.cased, status: "cancelled" });
  });
});

describe("a document number that names no single document never writes", () => {
  it("offers both types when a bare sequence names an invoice and a note", async () => {
    const error = await rejection(() =>
      kit.invoke(cancelDocument, { documentNumber: "57" }),
    );
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    if (error instanceof EntityLookupAmbiguousError) {
      expect(error.target).toEqual({ kind: "document", query: "57" });
      expect(
        [...error.options].toSorted((a, b) => a.id.localeCompare(b.id)),
      ).toEqual(
        [
          { id: fixtures.delivery57, label: DELIVERY_57 },
          { id: fixtures.invoice57, label: INVOICE_57 },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      expect(error.optionsTruncated).toBe(false);
    }
  });

  it("offers the candidates when a number prefixes several documents", async () => {
    const error = await rejection(() =>
      kit.invoke(shareDocument, { documentNumber: "РХ-0008" }),
    );
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    if (error instanceof EntityLookupAmbiguousError) {
      expect(error.options).toEqual([
        { id: fixtures.siblingOne, label: SIBLING_ONE },
        { id: fixtures.siblingTwo, label: SIBLING_TWO },
      ]);
      expect(error.optionsTruncated).toBe(false);
    }
  });

  it("caps the picker and says so past the shared option cap", async () => {
    const error = await rejection(() =>
      kit.invoke(cancelDocument, { documentNumber: "РХ-0009" }),
    );
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    if (error instanceof EntityLookupAmbiguousError) {
      expect(error.options).toHaveLength(ENTITY_LOOKUP_OPTIONS_MAX);
      expect(error.optionsTruncated).toBe(true);
    }
  });

  it("refuses another company's document number with not-found", async () => {
    for (const documentNumber of [FOREIGN_NUMBER, "999", "РХ-0007"]) {
      const error = await rejection(() =>
        kit.invoke(cancelDocument, { documentNumber }),
      );
      expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
      if (error instanceof EntityLookupUnmatchedError) {
        expect(error.options).toEqual([]);
      }
    }
  });

  it("keeps company A's number out of company B's reach", async () => {
    expect(
      await rejection(() =>
        kit.invoke(cancelDocument, { documentNumber: INVOICE_57 }, asCompanyB),
      ),
    ).toBeInstanceOf(EntityLookupUnmatchedError);
  });

  it("reads the bare sequence against each company's own prefix", async () => {
    expect(
      await kit.invoke(cancelDocument, { documentNumber: "131" }, asCompanyB),
    ).toMatchObject({ documentId: fixtures.foreign, status: "cancelled" });
  });

  it("rejects an input carrying neither reference or both", async () => {
    for (const input of [
      {},
      { documentId: fixtures.shared, documentNumber: SHARED_NUMBER },
    ]) {
      expect(
        await rejection(() => kit.invoke(cancelDocument, input)),
      ).toBeInstanceOf(ValidationError);
    }
  });
});

describe("the preview resolves the same reference and mints nothing", () => {
  it("names the resolved document and leaves the share tokens untouched", async () => {
    const error = await rejection(() =>
      kit.invoke(
        shareDocument,
        { documentNumber: "200" },
        {},
        { request: { requireConfirmation: true } },
      ),
    );
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    if (error instanceof ConfirmationRequiredError) {
      expect(error.challenge.preview?.title).toBe(
        `Поділитися документом ${SHARED_NUMBER}`,
      );
    }
    expect(
      await kit.db.runtime.db
        .select({ id: documentShareTokens.id })
        .from(documentShareTokens)
        .where(eq(documentShareTokens.documentId, fixtures.shared)),
    ).toEqual([]);
  });

  it("binds the confirmed sign request to the id the number resolved", async () => {
    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await rejection(() =>
      kit.invoke(
        requestSign,
        { documentNumber: "300" },
        {},
        { deps, request: { idempotencyKey } },
      ),
    );
    expect(unconfirmed).toBeInstanceOf(ConfirmationRequiredError);
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw unconfirmed;
    }
    expect(unconfirmed.challenge.preview?.title).toBe(
      requestSignPreviewTitle(SIGNABLE_NUMBER),
    );

    const confirmed = await kit.invoke(
      requestSign,
      { documentNumber: "300" },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    expect(confirmed).toEqual({ documentId: fixtures.signable });

    const rows = await kit.db.runtime.db
      .select({ signRequestedAt: documents.signRequestedAt })
      .from(documents)
      .where(eq(documents.id, fixtures.signable));
    expect(rows[0]?.signRequestedAt).toBeInstanceOf(Date);
  });

  it("replays the stored cancel for a repeated number and key", async () => {
    const idempotencyKey = randomUUID();
    const first = await kit.invoke(
      cancelDocument,
      { documentNumber: "400" },
      {},
      { request: { idempotencyKey } },
    );
    expect(first).toMatchObject({ documentId: fixtures.idempotent });
    expect(
      await kit.invoke(
        cancelDocument,
        { documentNumber: "400" },
        {},
        { request: { idempotencyKey } },
      ),
    ).toEqual(first);
  });
});

describe("a write that fails after resolution audits the document it named (SHO-867)", () => {
  async function auditRow(requestId: string) {
    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("records the resolved document id when the number names a cancelled document", async () => {
    await kit.invoke(cancelDocument, { documentId: fixtures.auditConflict });

    const requestId = randomUUID();
    expect(
      await rejection(() =>
        kit.invoke(
          cancelDocument,
          { documentNumber: "500" },
          {},
          { request: { requestId } },
        ),
      ),
    ).toBeInstanceOf(ConflictError);

    expect(await auditRow(requestId)).toMatchObject({
      action: "documents.cancel",
      companyId: companyA,
      targetType: "document",
      targetId: fixtures.auditConflict,
      outcome: "CONFLICT",
    });
  });

  it("leaves the target unknown when the number names no document", async () => {
    const requestId = randomUUID();
    await rejection(() =>
      kit.invoke(
        cancelDocument,
        { documentNumber: "777" },
        {},
        { request: { requestId } },
      ),
    );

    expect((await auditRow(requestId))?.targetId).toBe("unknown");
  });

  it("never records company A's document id for company B's number", async () => {
    const requestId = randomUUID();
    await rejection(() =>
      kit.invoke(
        cancelDocument,
        { documentNumber: SPOKEN_NUMBER },
        asCompanyB,
        { request: { requestId } },
      ),
    );

    const row = await auditRow(requestId);
    expect(row?.companyId).toBe(companyB);
    expect(row?.targetId).toBe("unknown");
    expect(row?.targetId).not.toBe(fixtures.spoken);
  });
});
