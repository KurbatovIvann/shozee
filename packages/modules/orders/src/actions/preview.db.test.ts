import { randomUUID } from "node:crypto";

import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
} from "@showzy/core";
import { ConfirmationRequiredError, NotFoundError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cancelOrder } from "./cancel.js";
import { completeOrder } from "./complete.js";
import { confirmOrder } from "./confirm.js";
import { createOrder } from "./create.js";
import { startOrder } from "./start.js";

const FOREIGN_CUSTOMER_NAME = "Богдан Фореіньчук";
const FOREIGN_PRODUCT_NAME = "Таємний торт";
const CUSTOMER_NAME = "Олена Коваль";
const ORDER_COMMENT = "Доставити до 14:00";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  cake: randomUUID(),
  box: randomUUID(),
  foreignProduct: randomUUID(),
  orderA: randomUUID(),
  orderB: randomUUID(),
  itemCake: randomUUID(),
  itemBox: randomUUID(),
  itemForeign: randomUUID(),
};

let kit: TestKit;
let confirming: ActionPipelineDeps;

function previewOf(error: unknown) {
  expect(error).toBeInstanceOf(ConfirmationRequiredError);
  if (!(error instanceof ConfirmationRequiredError)) {
    throw error;
  }
  const preview = error.challenge.preview;
  if (preview === undefined) {
    throw new Error("challenge carried no preview card");
  }
  return preview;
}

async function previewCard(
  run: () => Promise<unknown>,
): Promise<ReturnType<typeof previewOf>> {
  const error = await run().then(
    () => {
      throw new Error("expected ConfirmationRequiredError");
    },
    (caught: unknown) => caught,
  );
  return previewOf(error);
}

function previewOptions() {
  return {
    deps: confirming,
    request: { requireConfirmation: true as const },
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

beforeAll(async () => {
  kit = await createTestKit();
  confirming = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: CUSTOMER_NAME,
      email: "olena@orders-preview.test",
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: FOREIGN_CUSTOMER_NAME,
      email: "bohdan@orders-preview.test",
    },
  ]);

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.cake,
      companyId: companyA,
      name: "Торт Наполеон",
      basePriceMinor: 25_000n,
    },
    {
      id: fixtures.box,
      companyId: companyA,
      name: "Коробка",
      basePriceMinor: 1_250n,
    },
    {
      id: fixtures.foreignProduct,
      companyId: companyB,
      name: FOREIGN_PRODUCT_NAME,
      basePriceMinor: 100n,
    },
  ]);

  await kit.db.runtime.db.insert(orders).values([
    {
      id: fixtures.orderA,
      companyId: companyA,
      orderNumber: "KA-7",
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "new",
      totalNetMinor: 51_875n,
      totalTaxMinor: 0n,
      totalGrossMinor: 51_875n,
      currency: "UAH",
    },
    {
      id: fixtures.orderB,
      companyId: companyB,
      orderNumber: "MB-3",
      customerId: fixtures.customerB,
      customerNameSnapshot: FOREIGN_CUSTOMER_NAME,
      status: "new",
      totalNetMinor: 100n,
      totalTaxMinor: 0n,
      totalGrossMinor: 100n,
      currency: "UAH",
    },
  ]);

  await kit.db.runtime.db.insert(orderItems).values([
    {
      id: fixtures.itemCake,
      companyId: companyA,
      orderId: fixtures.orderA,
      productId: fixtures.cake,
      titleSnapshot: "Торт Наполеон",
      createdAt: new Date("2026-02-01T09:00:00.000Z"),
      quantityMilli: 2_000n,
      unitPriceMinor: 25_000n,
      taxTreatment: "exempt",
      netAmountMinor: 50_000n,
      grossAmountMinor: 50_000n,
      priceSource: "base",
      resolverVersion: 1,
    },
    {
      id: fixtures.itemBox,
      companyId: companyA,
      orderId: fixtures.orderA,
      productId: fixtures.box,
      titleSnapshot: "Коробка",
      createdAt: new Date("2026-02-01T09:00:05.000Z"),
      quantityMilli: 1_500n,
      unitPriceMinor: 1_250n,
      taxTreatment: "exempt",
      netAmountMinor: 1_875n,
      grossAmountMinor: 1_875n,
      priceSource: "base",
      resolverVersion: 1,
    },
    {
      id: fixtures.itemForeign,
      companyId: companyB,
      orderId: fixtures.orderB,
      productId: fixtures.foreignProduct,
      titleSnapshot: FOREIGN_PRODUCT_NAME,
      quantityMilli: 1_000n,
      unitPriceMinor: 100n,
      taxTreatment: "exempt",
      netAmountMinor: 100n,
      grossAmountMinor: 100n,
      priceSource: "base",
      resolverVersion: 1,
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("orders preview cards (SHO-750)", () => {
  it("previews orders.create with resolved names, snapshots and totals", async () => {
    const preview = await previewCard(() =>
      kit.invoke(
        createOrder,
        {
          customer: { by: "id", id: fixtures.customerA },
          items: [
            {
              product: { by: "id", id: fixtures.cake },
              quantity: { milli: "2000" },
            },
            {
              product: { by: "query", value: "Коробка" },
              quantity: { milli: "1500" },
            },
          ],
          comment: ORDER_COMMENT,
        },
        {},
        { deps: confirming, request: { requireConfirmation: true } },
      ),
    );

    expect(preview.title).toBe(`Нове замовлення: ${CUSTOMER_NAME}`);
    expect(preview.lines).toEqual([
      { label: "Торт Наполеон", value: "2 × 250,00 грн = 500,00 грн" },
      { label: "Коробка", value: "1,5 × 12,50 грн = 18,75 грн" },
      { label: "Разом", value: "518,75 грн" },
      { label: "Коментар", value: ORDER_COMMENT },
    ]);
    expect(preview.notes).toEqual(["Ціни: базова ціна"]);

    const created = await kit.db.runtime.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.customerId, fixtures.customerA));
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(fixtures.orderA);
  });

  it("refuses a foreign product in the create preview without leaking its name", async () => {
    const error = await rejection(() =>
      kit.invoke(
        createOrder,
        {
          customer: { by: "id", id: fixtures.customerA },
          items: [
            {
              product: { by: "id", id: fixtures.foreignProduct },
              quantity: { milli: "1000" },
            },
          ],
        },
        {},
        { deps: confirming, request: { requireConfirmation: true } },
      ),
    );

    expect(error).toBeInstanceOf(NotFoundError);
    if (error instanceof NotFoundError) {
      expect(error.clientMessage).not.toContain(FOREIGN_PRODUCT_NAME);
    }
  });

  it("previews every status transition from the persisted snapshots", async () => {
    const subjects = [
      {
        subject: "Підтвердити замовлення KA-7",
        run: () =>
          kit.invoke(
            confirmOrder,
            { orderId: fixtures.orderA },
            {},
            previewOptions(),
          ),
      },
      {
        subject: "Взяти в роботу замовлення KA-7",
        run: () =>
          kit.invoke(
            startOrder,
            { orderId: fixtures.orderA },
            {},
            previewOptions(),
          ),
      },
      {
        subject: "Завершити замовлення KA-7",
        run: () =>
          kit.invoke(
            completeOrder,
            { orderId: fixtures.orderA },
            {},
            previewOptions(),
          ),
      },
      {
        subject: "Скасувати замовлення KA-7",
        run: () =>
          kit.invoke(
            cancelOrder,
            { orderId: fixtures.orderA },
            {},
            previewOptions(),
          ),
      },
    ];

    for (const { subject, run } of subjects) {
      const preview = await previewCard(run);

      expect(preview.title, subject).toBe(`${subject}: ${CUSTOMER_NAME}`);
      expect(preview.lines, subject).toEqual([
        { label: "Торт Наполеон", value: "2 × 250,00 грн = 500,00 грн" },
        { label: "Коробка", value: "1,5 × 12,50 грн = 18,75 грн" },
        { label: "Разом", value: "518,75 грн" },
        { label: "Поточний статус", value: "новий" },
      ]);
      expect(preview.notes, subject).toEqual(["Ціни: базова ціна"]);
    }

    const rows = await kit.db.runtime.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, fixtures.orderA));
    expect(rows[0]?.status).toBe("new");
  });

  it("shows and persists the same trimmed comment", async () => {
    const padded = `   ${ORDER_COMMENT}   `;
    const input = {
      customer: { by: "id" as const, id: fixtures.customerA },
      items: [
        {
          product: { by: "id" as const, id: fixtures.cake },
          quantity: { milli: "1000" },
        },
      ],
      comment: padded,
    };

    const preview = await previewCard(() =>
      kit.invoke(createOrder, input, {}, previewOptions()),
    );
    expect(preview.lines.at(-1)).toEqual({
      label: "Коментар",
      value: ORDER_COMMENT,
    });

    const summary = await kit.invoke(createOrder, input, {});
    const rows = await kit.db.runtime.db
      .select({ comment: orders.comment })
      .from(orders)
      .where(eq(orders.id, summary.orderId));
    expect(rows[0]?.comment).toBe(ORDER_COMMENT);

    const blank = await kit.invoke(
      createOrder,
      { ...input, comment: "   " },
      {},
    );
    const blankRows = await kit.db.runtime.db
      .select({ comment: orders.comment })
      .from(orders)
      .where(eq(orders.id, blank.orderId));
    expect(blankRows[0]?.comment).toBeNull();
  });

  it("refuses a foreign order id exactly like a missing one", async () => {
    const probes = [
      (orderId: string) =>
        kit.invoke(confirmOrder, { orderId }, {}, previewOptions()),
      (orderId: string) =>
        kit.invoke(startOrder, { orderId }, {}, previewOptions()),
      (orderId: string) =>
        kit.invoke(completeOrder, { orderId }, {}, previewOptions()),
      (orderId: string) =>
        kit.invoke(cancelOrder, { orderId }, {}, previewOptions()),
    ];

    for (const probe of probes) {
      const foreign = await rejection(() => probe(fixtures.orderB));
      const missing = await rejection(() => probe(randomUUID()));

      expect(foreign).toBeInstanceOf(NotFoundError);
      expect(missing).toBeInstanceOf(NotFoundError);
      if (
        foreign instanceof NotFoundError &&
        missing instanceof NotFoundError
      ) {
        expect(foreign.code).toBe(missing.code);
        expect(foreign.clientMessage).toBe(missing.clientMessage);
        expect(foreign.clientMessage).not.toContain(FOREIGN_CUSTOMER_NAME);
      }
    }
  });
});
