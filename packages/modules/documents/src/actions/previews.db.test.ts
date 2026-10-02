import { randomUUID } from "node:crypto";

import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
  type ImplementedAction,
} from "@showzy/core";
import {
  ConfirmationRequiredError,
  NotFoundError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { companyLegalInfo } from "@showzy/db/schema/companies";
import { companyCustomers, counterparties } from "@showzy/db/schema/customers";
import {
  documentItems,
  documents,
  documentShareTokens,
} from "@showzy/db/schema/documents";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { cancelDocument } from "./cancel.js";
import { createFromOrder } from "./create-from-order.js";
import {
  REQUEST_SIGN_KEY_POSSESSION_NOTE,
  requestSign,
  requestSignPreviewTitle,
} from "./request-sign.js";
import { shareDocument } from "./share.js";
import { configureDocumentShareOrigin } from "../services/share-origin.js";
import { hashDocumentShareToken } from "../services/token-hash.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderA: randomUUID(),
  orderShared: randomUUID(),
  orderRevoked: randomUUID(),
  orderExpired: randomUUID(),
  itemA: randomUUID(),
  itemShared: randomUUID(),
  itemRevoked: randomUUID(),
  itemExpired: randomUUID(),
  orderConfirmShare: randomUUID(),
  itemConfirmShare: randomUUID(),
  docA: randomUUID(),
  docConfirmShare: randomUUID(),
  docShared: randomUUID(),
  docRevoked: randomUUID(),
  docExpired: randomUUID(),
  counterpartyA: randomUUID(),
  counterpartyB: randomUUID(),
  missingId: randomUUID(),
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

const TEST_ORIGIN = "https://documents.test";

let kit: TestKit;

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

async function previewOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
): Promise<ActionPreview> {
  const error = await kit
    .invoke(
      action,
      input,
      {},
      {
        request: { requireConfirmation: true },
      },
    )
    .then(
      () => {
        throw new Error("expected ConfirmationRequiredError");
      },
      (thrown: unknown) => thrown,
    );
  if (!(error instanceof ConfirmationRequiredError)) {
    throw error;
  }
  const preview = error.challenge.preview;
  if (preview === undefined) {
    throw new Error("expected a structured preview card");
  }
  expect(error.challenge.summary).toBe(preview.title);
  return preview;
}

async function refusalOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
): Promise<unknown> {
  return await kit
    .invoke(
      action,
      input,
      {},
      {
        request: { requireConfirmation: true },
      },
    )
    .then(
      () => {
        throw new Error("expected a refusal");
      },
      (thrown: unknown) => thrown,
    );
}

async function shareTokenRowsOf(
  documentId: string,
): Promise<readonly (typeof documentShareTokens.$inferSelect)[]> {
  return await kit.db.runtime.db
    .select()
    .from(documentShareTokens)
    .where(eq(documentShareTokens.documentId, documentId))
    .orderBy(documentShareTokens.tokenHash);
}

function expectSameRefusal(foreign: unknown, missing: unknown): void {
  if (
    !(foreign instanceof NotFoundError) ||
    !(missing instanceof NotFoundError)
  ) {
    throw foreign;
  }
  expect(foreign.code).toBe(missing.code);
  expect(foreign.clientMessage).toBe(missing.clientMessage);
}

async function insertSeedOrder(values: {
  readonly id: string;
  readonly itemId: string;
  readonly companyId: string;
  readonly customerId: string;
  readonly productId: string;
  readonly orderNumber: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: 250n,
    totalTaxMinor: 0n,
    totalGrossMinor: 250n,
    currency: "UAH",
  });
  await kit.db.runtime.db.insert(orderItems).values({
    id: values.itemId,
    companyId: values.companyId,
    orderId: values.id,
    productId: values.productId,
    titleSnapshot: "Seed line",
    quantityMilli: 1000n,
    unitPriceMinor: 250n,
    taxTreatment: "exempt",
    netAmountMinor: 250n,
    grossAmountMinor: 250n,
    priceSource: "base",
    resolverVersion: 1,
  });
}

async function insertSeedDocument(values: {
  readonly id: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly documentNumber: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId: values.orderId,
    counterpartyId: null,
    type: "payment_invoice",
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
  configureDocumentShareOrigin(TEST_ORIGIN);
  kit = await createTestKit();

  await kit.db.runtime.db.insert(companyLegalInfo).values([
    { companyId: companyA, companyType: "tov", legalName: "ТОВ Альфа" },
    { companyId: companyB, companyType: "fop", legalName: "ФОП Борис" },
  ]);

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

  await kit.db.runtime.db.insert(counterparties).values([
    {
      id: fixtures.counterpartyA,
      companyId: companyA,
      customerId: fixtures.customerA,
      name: "ТОВ Покупець",
    },
    {
      id: fixtures.counterpartyB,
      companyId: companyB,
      customerId: fixtures.customerB,
      name: "Чужий покупець",
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

  await insertSeedOrder({
    id: fixtures.orderA,
    itemId: fixtures.itemA,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    orderNumber: "KA-1",
  });
  await insertSeedDocument({
    id: fixtures.docA,
    companyId: companyA,
    orderId: fixtures.orderA,
    documentNumber: "KA-РХ-000001",
  });
  await insertSeedOrder({
    id: fixtures.orderShared,
    itemId: fixtures.itemShared,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    orderNumber: "KA-2",
  });
  await insertSeedOrder({
    id: fixtures.orderRevoked,
    itemId: fixtures.itemRevoked,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    orderNumber: "KA-3",
  });
  await insertSeedOrder({
    id: fixtures.orderExpired,
    itemId: fixtures.itemExpired,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    orderNumber: "KA-4",
  });
  await insertSeedDocument({
    id: fixtures.docShared,
    companyId: companyA,
    orderId: fixtures.orderShared,
    documentNumber: "KA-РХ-000002",
  });
  await insertSeedDocument({
    id: fixtures.docRevoked,
    companyId: companyA,
    orderId: fixtures.orderRevoked,
    documentNumber: "KA-РХ-000003",
  });
  await insertSeedDocument({
    id: fixtures.docExpired,
    companyId: companyA,
    orderId: fixtures.orderExpired,
    documentNumber: "KA-РХ-000004",
  });
  await insertSeedOrder({
    id: fixtures.orderConfirmShare,
    itemId: fixtures.itemConfirmShare,
    companyId: companyA,
    customerId: fixtures.customerA,
    productId: fixtures.productA,
    orderNumber: "KA-5",
  });
  await insertSeedDocument({
    id: fixtures.docConfirmShare,
    companyId: companyA,
    orderId: fixtures.orderConfirmShare,
    documentNumber: "KA-РХ-000005",
  });
  await kit.db.runtime.db.insert(documentItems).values({
    id: randomUUID(),
    companyId: companyA,
    documentId: fixtures.docConfirmShare,
    productId: fixtures.productA,
    titleSnapshot: "Seed line",
    quantityMilli: 1000n,
    unitPriceMinor: 250n,
    taxTreatment: "exempt",
    netAmountMinor: 250n,
    grossAmountMinor: 250n,
    currency: "UAH",
  });

  await kit.db.runtime.db.insert(documentShareTokens).values([
    {
      companyId: companyA,
      documentId: fixtures.docShared,
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      companyId: companyA,
      documentId: fixtures.docConfirmShare,
      tokenHash: "d".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      companyId: companyA,
      documentId: fixtures.docRevoked,
      tokenHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date("2026-03-16T00:00:00Z"),
    },
    {
      companyId: companyA,
      documentId: fixtures.docExpired,
      tokenHash: "c".repeat(64),
      expiresAt: new Date(Date.now() - 60_000),
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

const documentCardLines = [
  { label: "Документ", value: "KA-РХ-000001" },
  { label: "Тип", value: "Рахунок на оплату" },
  { label: "Статус", value: "Виданий" },
];

describe("documents preview cards (core.md §7)", () => {
  it("previews documents.cancel from the stored document", async () => {
    const preview = await previewOf(cancelDocument, {
      documentId: fixtures.docA,
    });
    expect(preview.title).toBe("Скасувати документ KA-РХ-000001");
    expect(preview.lines).toEqual(documentCardLines);
    expect(preview.notes?.[0]).toContain("нумерацію");
  });

  it("previews documents.share as a card about a link not yet minted", async () => {
    const preview = await previewOf(shareDocument, {
      documentId: fixtures.docA,
    });
    expect(preview.title).toBe("Поділитися документом KA-РХ-000001");
    expect(preview.lines).toEqual(documentCardLines);
    expect(preview.notes).toEqual([
      "Буде створено нове посилання, і воно діє 90 днів.",
    ]);
  });

  it("rotates the token only once the previewed documents.share is confirmed", async () => {
    const deps = confirmationPipeline(kit);
    const idempotencyKey = randomUUID();
    const unconfirmed = await kit
      .invoke(
        shareDocument,
        { documentId: fixtures.docConfirmShare },
        {},
        { deps, request: { idempotencyKey, requireConfirmation: true } },
      )
      .then(
        () => {
          throw new Error("expected ConfirmationRequiredError");
        },
        (thrown: unknown) => thrown,
      );
    if (!(unconfirmed instanceof ConfirmationRequiredError)) {
      throw unconfirmed;
    }
    expect(unconfirmed.challenge.preview?.notes).toEqual([
      "Чинне посилання буде відкликано — працюватиме лише нове, і воно діє 90 днів.",
    ]);
    expect(await shareTokenRowsOf(fixtures.docConfirmShare)).toMatchObject([
      { tokenHash: "d".repeat(64), revokedAt: null },
    ]);

    const confirmed = await kit.invoke(
      shareDocument,
      { documentId: fixtures.docConfirmShare },
      {},
      {
        deps,
        request: {
          idempotencyKey,
          requireConfirmation: true,
          confirmationChallengeId: unconfirmed.challenge.challengeId,
        },
      },
    );
    const rows = await shareTokenRowsOf(fixtures.docConfirmShare);
    expect(rows).toHaveLength(2);
    const revoked = rows.filter((row) => row.revokedAt !== null);
    const active = rows.filter((row) => row.revokedAt === null);
    expect(revoked.map((row) => row.tokenHash)).toEqual(["d".repeat(64)]);
    expect(active.map((row) => row.tokenHash)).toEqual([
      hashDocumentShareToken(confirmed.token),
    ]);
  });

  it("warns about the revoked link only when one is still live", async () => {
    const preview = await previewOf(shareDocument, {
      documentId: fixtures.docShared,
    });
    expect(preview.notes).toEqual([
      "Чинне посилання буде відкликано — працюватиме лише нове, і воно діє 90 днів.",
    ]);
  });

  it("treats a revoked link as no link at all", async () => {
    const preview = await previewOf(shareDocument, {
      documentId: fixtures.docRevoked,
    });
    expect(preview.notes?.[0]).not.toContain("відкликано");
  });

  it("treats an expired unrevoked link as no link at all", async () => {
    const preview = await previewOf(shareDocument, {
      documentId: fixtures.docExpired,
    });
    expect(preview.notes).toEqual([
      "Буде створено нове посилання, і воно діє 90 днів.",
    ]);
  });

  it("previews documents.requestSign with the key-possession note", async () => {
    const preview = await previewOf(requestSign, {
      documentId: fixtures.docA,
    });
    expect(preview.title).toBe("Запросити підписання документа KA-РХ-000001");
    expect(preview.notes ?? []).toEqual([REQUEST_SIGN_KEY_POSSESSION_NOTE]);
  });

  it("keeps the key-possession warning out of the summary the assistant reads", async () => {
    const error = await refusalOf(requestSign, { documentId: fixtures.docA });
    if (!(error instanceof ConfirmationRequiredError)) {
      throw error;
    }
    expect(error.challenge.summary).toBe(
      requestSignPreviewTitle("KA-РХ-000001"),
    );
    expect(error.challenge.summary).not.toContain(
      REQUEST_SIGN_KEY_POSSESSION_NOTE,
    );
    expect(error.challenge.preview?.notes).toEqual([
      REQUEST_SIGN_KEY_POSSESSION_NOTE,
    ]);
  });

  it("previews documents.createFromOrder through the nested order read", async () => {
    const preview = await previewOf(createFromOrder, {
      orderId: fixtures.orderA,
      type: "payment_invoice",
      basis: "Договір 7",
    });
    expect(preview.title).toBe("Створити документ за замовленням KA-1");
    expect(preview.lines).toEqual([
      { label: "Тип", value: "Рахунок на оплату" },
      { label: "Замовлення", value: "KA-1" },
      { label: "Позицій", value: "1" },
      { label: "Покупець", value: "Customer A" },
      { label: "Шаблон", value: "payment_invoice.branded" },
      { label: "Підстава", value: "Договір 7" },
    ]);
  });

  it("names the default layout and the empty basis the handler would write", async () => {
    const preview = await previewOf(createFromOrder, {
      orderId: fixtures.orderA,
      type: "delivery_note",
    });
    expect(preview.lines.slice(4)).toEqual([
      { label: "Шаблон", value: "delivery_note.parties" },
      { label: "Підстава", value: "—" },
    ]);
  });

  it("names the counterparty the document is issued to and the layout", async () => {
    const preview = await previewOf(createFromOrder, {
      orderId: fixtures.orderA,
      type: "payment_invoice",
      counterpartyId: fixtures.counterpartyA,
      layoutKey: "payment_invoice.branded",
    });
    expect(preview.lines.slice(3)).toEqual([
      { label: "Покупець", value: "ТОВ Покупець" },
      { label: "Шаблон", value: "payment_invoice.branded" },
      { label: "Підстава", value: "—" },
    ]);
  });

  it("refuses a foreign counterparty in the createFromOrder card like a missing one", async () => {
    expectSameRefusal(
      await refusalOf(createFromOrder, {
        orderId: fixtures.orderA,
        type: "payment_invoice",
        counterpartyId: fixtures.counterpartyB,
      }),
      await refusalOf(createFromOrder, {
        orderId: fixtures.orderA,
        type: "payment_invoice",
        counterpartyId: fixtures.missingId,
      }),
    );
  });

  it("leaves nothing behind when a card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, fixtures.docA));
    expect(rows[0]?.status).toBe("issued");
  });
});
