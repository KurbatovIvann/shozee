import { randomUUID } from "node:crypto";

import {
  ConfirmationRequiredError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orderItems, orders } from "@showzy/db/schema/orders";
import {
  EntityLookupAmbiguousError,
  EntityLookupUnmatchedError,
} from "@showzy/module-kit/entity-lookup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cancelOrder } from "./cancel.js";
import { completeOrder } from "./complete.js";
import { confirmOrder } from "./confirm.js";
import { startOrder } from "./start.js";

const CUSTOMER_NAME = "Олена Коваль";
const FOREIGN_CUSTOMER_NAME = "Богдан Фореіньчук";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  cake: randomUUID(),
  spoken: randomUUID(),
  startable: randomUUID(),
  completable: randomUUID(),
  cancellable: randomUUID(),
  siblingOne: randomUUID(),
  siblingTwo: randomUUID(),
  foreign: randomUUID(),
  itemSpoken: randomUUID(),
};

const SPOKEN_NUMBER = "KA-131";
const SIBLING_ONE_NUMBER = "KA-801";
const SIBLING_TWO_NUMBER = "KA-802";
const FOREIGN_NUMBER = "MB-131";

let kit: TestKit;

const asCompanyB = {
  userId: kitIdentities.users.boris,
  companyId: kitIdentities.companies.b,
};

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error("expected a rejection");
    },
    (caught: unknown) => caught,
  );
}

function orderRow(args: {
  readonly id: string;
  readonly companyId: string;
  readonly orderNumber: string;
  readonly customerId: string;
  readonly customerNameSnapshot: string;
  readonly status: "new" | "confirmed" | "in_progress";
}) {
  return {
    ...args,
    confirmedAt:
      args.status === "new" ? null : new Date("2026-02-01T09:00:00.000Z"),
    totalNetMinor: 1_000n,
    totalTaxMinor: 0n,
    totalGrossMinor: 1_000n,
    currency: "UAH",
  };
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await kit.db.runtime.db.insert(companyCustomers).values([
    {
      id: fixtures.customerA,
      companyId: companyA,
      name: CUSTOMER_NAME,
      email: "olena@order-reference.test",
    },
    {
      id: fixtures.customerB,
      companyId: companyB,
      name: FOREIGN_CUSTOMER_NAME,
      email: "bohdan@order-reference.test",
    },
  ]);

  await kit.db.runtime.db.insert(products).values({
    id: fixtures.cake,
    companyId: companyA,
    name: "Торт Наполеон",
    basePriceMinor: 1_000n,
  });

  await kit.db.runtime.db.insert(orders).values([
    orderRow({
      id: fixtures.spoken,
      companyId: companyA,
      orderNumber: SPOKEN_NUMBER,
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "new",
    }),
    orderRow({
      id: fixtures.startable,
      companyId: companyA,
      orderNumber: "KA-132",
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "confirmed",
    }),
    orderRow({
      id: fixtures.completable,
      companyId: companyA,
      orderNumber: "KA-133",
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "in_progress",
    }),
    orderRow({
      id: fixtures.cancellable,
      companyId: companyA,
      orderNumber: "KA-134",
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "new",
    }),
    orderRow({
      id: fixtures.siblingOne,
      companyId: companyA,
      orderNumber: SIBLING_ONE_NUMBER,
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "new",
    }),
    orderRow({
      id: fixtures.siblingTwo,
      companyId: companyA,
      orderNumber: SIBLING_TWO_NUMBER,
      customerId: fixtures.customerA,
      customerNameSnapshot: CUSTOMER_NAME,
      status: "new",
    }),
    orderRow({
      id: fixtures.foreign,
      companyId: companyB,
      orderNumber: FOREIGN_NUMBER,
      customerId: fixtures.customerB,
      customerNameSnapshot: FOREIGN_CUSTOMER_NAME,
      status: "new",
    }),
  ]);

  await kit.db.runtime.db.insert(orderItems).values({
    id: fixtures.itemSpoken,
    companyId: companyA,
    orderId: fixtures.spoken,
    productId: fixtures.cake,
    titleSnapshot: "Торт Наполеон",
    createdAt: new Date("2026-02-01T09:00:00.000Z"),
    quantityMilli: 1_000n,
    unitPriceMinor: 1_000n,
    taxTreatment: "exempt",
    netAmountMinor: 1_000n,
    grossAmountMinor: 1_000n,
    priceSource: "base",
    resolverVersion: 1,
  });
});

afterAll(async () => {
  await kit.db.close();
});

describe("orders lifecycle writes take an id or an order number (SHO-853)", () => {
  it("confirms by canonical id exactly as before", async () => {
    expect(
      await kit.invoke(confirmOrder, { orderId: fixtures.cancellable }),
    ).toMatchObject({
      orderId: fixtures.cancellable,
      status: "confirmed",
    });
  });

  it("starts an order named by the spoken number alone", async () => {
    expect(await kit.invoke(startOrder, { orderNumber: "132" })).toEqual({
      orderId: fixtures.startable,
      customerId: fixtures.customerA,
      status: "in_progress",
    });
  });

  it("completes an order named by its canonical number, hash and case", async () => {
    expect(await kit.invoke(completeOrder, { orderNumber: "#ka-133" })).toEqual(
      {
        orderId: fixtures.completable,
        customerId: fixtures.customerA,
        status: "done",
      },
    );
  });

  it("cancels an order named by the spoken number", async () => {
    expect(await kit.invoke(cancelOrder, { orderNumber: "131" })).toEqual({
      orderId: fixtures.spoken,
      customerId: fixtures.customerA,
      status: "canceled",
    });
  });
});

describe("an order number that names no single order never writes", () => {
  it("offers the candidates when a number prefixes several orders", async () => {
    const error = await rejection(() =>
      kit.invoke(confirmOrder, { orderNumber: "80" }),
    );
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    if (error instanceof EntityLookupAmbiguousError) {
      expect(error.target).toEqual({ kind: "order", query: "80" });
      expect(error.options).toEqual([
        { id: fixtures.siblingOne, label: SIBLING_ONE_NUMBER },
        { id: fixtures.siblingTwo, label: SIBLING_TWO_NUMBER },
      ]);
      expect(error.optionsTruncated).toBe(false);
    }
  });

  it("refuses another company's order number with not-found and no options", async () => {
    for (const orderNumber of [FOREIGN_NUMBER, "999"]) {
      const error = await rejection(() =>
        kit.invoke(confirmOrder, { orderNumber }),
      );
      expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
      if (error instanceof EntityLookupUnmatchedError) {
        expect(error.options).toEqual([]);
      }
    }
  });

  it("keeps company A's number out of company B's reach", async () => {
    const error = await rejection(() =>
      kit.invoke(confirmOrder, { orderNumber: SPOKEN_NUMBER }, asCompanyB),
    );
    expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
  });

  it("reads the spoken number against each company's own prefix", async () => {
    expect(
      await kit.invoke(confirmOrder, { orderNumber: "131" }, asCompanyB),
    ).toMatchObject({ orderId: fixtures.foreign, status: "confirmed" });
  });

  it("rejects an input carrying neither reference or both", async () => {
    for (const input of [
      {},
      { orderId: fixtures.spoken, orderNumber: SPOKEN_NUMBER },
    ]) {
      expect(
        await rejection(() => kit.invoke(cancelOrder, input)),
      ).toBeInstanceOf(ValidationError);
    }
  });
});

describe("the preview card resolves the same reference", () => {
  it("names the resolved order on the pause the AI write takes", async () => {
    const error = await rejection(() =>
      kit.invoke(
        confirmOrder,
        { orderNumber: "131" },
        {},
        { request: { requireConfirmation: true } },
      ),
    );
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
    if (error instanceof ConfirmationRequiredError) {
      expect(error.challenge.preview?.title).toBe(
        `Підтвердити замовлення ${SPOKEN_NUMBER}: ${CUSTOMER_NAME}`,
      );
    }
  });
});
