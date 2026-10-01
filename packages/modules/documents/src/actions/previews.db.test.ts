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
import { companyCustomers } from "@showzy/db/schema/customers";
import { documents } from "@showzy/db/schema/documents";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { cancelDocument } from "./cancel.js";
import { createFromOrder } from "./create-from-order.js";
import {
  REQUEST_SIGN_KEY_POSSESSION_NOTE,
  requestSign,
} from "./request-sign.js";
import { shareDocument } from "./share.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  productA: randomUUID(),
  productB: randomUUID(),
  orderA: randomUUID(),
  orderB: randomUUID(),
  itemA: randomUUID(),
  itemB: randomUUID(),
  docA: randomUUID(),
  docB: randomUUID(),
  missingId: randomUUID(),
};

const sellerSnapshot = {
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
};

const buyerSnapshot = {
  kind: "customer" as const,
  displayName: "Customer A",
};

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
        deps: confirmationPipeline(kit),
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
        deps: confirmationPipeline(kit),
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
  await insertSeedOrder({
    id: fixtures.orderB,
    itemId: fixtures.itemB,
    companyId: companyB,
    customerId: fixtures.customerB,
    productId: fixtures.productB,
    orderNumber: "KB-1",
  });

  await insertSeedDocument({
    id: fixtures.docA,
    companyId: companyA,
    orderId: fixtures.orderA,
    documentNumber: "KA-РХ-000001",
  });
  await insertSeedDocument({
    id: fixtures.docB,
    companyId: companyB,
    orderId: fixtures.orderB,
    documentNumber: "KB-РХ-000001",
  });
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

  it("previews documents.share without rotating the token", async () => {
    const preview = await previewOf(shareDocument, {
      documentId: fixtures.docA,
    });
    expect(preview.title).toBe("Поділитися документом KA-РХ-000001");
    expect(preview.lines).toEqual(documentCardLines);
  });

  it("previews documents.requestSign with the key-possession note", async () => {
    const preview = await previewOf(requestSign, {
      documentId: fixtures.docA,
    });
    expect(preview.title).toBe("Запросити підписання документа KA-РХ-000001");
    expect(preview.notes).toEqual([REQUEST_SIGN_KEY_POSSESSION_NOTE]);
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
      { label: "Підстава", value: "Договір 7" },
    ]);
  });

  it("leaves nothing behind when a card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, fixtures.docA));
    expect(rows[0]?.status).toBe("issued");
  });

  it("refuses a foreign document in the cancel card exactly like a missing one", async () => {
    expectSameRefusal(
      await refusalOf(cancelDocument, { documentId: fixtures.docB }),
      await refusalOf(cancelDocument, { documentId: fixtures.missingId }),
    );
  });

  it("refuses a foreign document in the share card exactly like a missing one", async () => {
    expectSameRefusal(
      await refusalOf(shareDocument, { documentId: fixtures.docB }),
      await refusalOf(shareDocument, { documentId: fixtures.missingId }),
    );
  });

  it("refuses a foreign document in the requestSign card exactly like a missing one", async () => {
    expectSameRefusal(
      await refusalOf(requestSign, { documentId: fixtures.docB }),
      await refusalOf(requestSign, { documentId: fixtures.missingId }),
    );
  });

  it("refuses a foreign order in the createFromOrder card like a missing one", async () => {
    expectSameRefusal(
      await refusalOf(createFromOrder, {
        orderId: fixtures.orderB,
        type: "payment_invoice",
      }),
      await refusalOf(createFromOrder, {
        orderId: fixtures.missingId,
        type: "payment_invoice",
      }),
    );
  });
});
