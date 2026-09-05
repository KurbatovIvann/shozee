import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import {
  dispatchOutboxBatch,
  executeAction,
  executeDelivery,
  implementAction,
  type EventSubscription,
} from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
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
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { companyCustomers } from "@showzy/db/schema/customers";
import { orderCards } from "@showzy/db/schema/chat";
import { orders } from "@showzy/db/schema/orders";
import { confirmOrder, createOrder, ordersCreated } from "@showzy/orders";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { getOrderCard } from "./get-order-card.js";
import { upsertOrderCard } from "./upsert-order-card.js";
import { upsertOrderCardInputSchema } from "./upsert-order-card.contract.js";
import {
  orderCardUpdaterConfirmed,
  orderCardUpdaterCreated,
  orderCardUpdaterSubscriptions,
} from "../events/order-card-updater.js";

const fixtures = {
  customerA: randomUUID(),
  customerB: randomUUID(),
  pBase: randomUUID(),
  pB: randomUUID(),
  orderIsolationA: randomUUID(),
  orderIsolationB: randomUUID(),
  orderConfirmFirst: randomUUID(),
  cardIsolationA: randomUUID(),
  cardIsolationB: randomUUID(),
};

const clerks = {
  noChatView: randomUUID(),
};

let kit: TestKit;

const emitCreatedThenFail = implementAction(
  defineActionContract({
    name: "orders.emitCreatedThenFailChat",
    description:
      "Test-local emitter that fails after buffering orders.created.",
    principal: "staff",
    transport: "internal",
    input: z.object({ orderId: z.uuid() }),
    output: z.object({ orderId: z.uuid() }),
    permissions: ["orders:create"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["orders.created"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(ordersCreated, {
        aggregate: { type: "order", id: input.orderId },
        payload: {
          orderId: input.orderId,
          customerId: fixtures.customerA,
          totalGrossMinor: "1",
          currency: "UAH",
          itemCount: 1,
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: (env) => {
      const parsed = z.object({ orderId: z.string() }).safeParse(env.input);
      return {
        type: "order",
        id: parsed.success ? parsed.data.orderId : "unknown",
      };
    },
  },
);

type OrderCardEnvelope = z.input<typeof upsertOrderCardInputSchema>;

function orderCardEnvelope(values: {
  readonly orderId: string;
  readonly name: "orders.created" | "orders.confirmed";
  readonly companyId: string;
}): OrderCardEnvelope {
  const eventId = randomUUID();
  return {
    eventId,
    name: values.name,
    version: 1,
    occurredAt: new Date().toISOString(),
    companyId: values.companyId,
    aggregate: { type: "order", id: values.orderId, sequence: "1" },
    actor: { type: "user", id: kitIdentities.users.anna, channel: "ui" },
    requestId: randomUUID(),
    correlationId: randomUUID(),
    causationId: eventId,
    payload: { orderId: values.orderId },
  };
}

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
  basePriceMinor: bigint;
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: values.basePriceMinor,
  });
}

async function insertOrder(values: {
  id: string;
  companyId: string;
  customerId: string;
  orderNumber: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: values.customerId,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
  });
}

async function countCompanyCards(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: orderCards.id })
    .from(orderCards)
    .where(eq(orderCards.companyId, companyId));
  return rows.length;
}

async function loadCardRow(orderId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(orderCards)
    .where(eq(orderCards.orderId, orderId));
  return rows[0];
}

async function driveToProcessed(
  subscription: EventSubscription,
  eventId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await executeDelivery(kit.pipeline, {
      subscription,
      eventId,
      claimedBy: "chat-test-worker",
    });
    if (
      outcome.status === "processed" ||
      outcome.status === "alreadyProcessed"
    ) {
      return;
    }
    if (outcome.status === "failed") {
      throw outcome.error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`delivery of ${eventId} did not reach processed`);
}

async function deliverNamedEvent(
  orderId: string,
  eventName: "orders.created" | "orders.confirmed",
): Promise<string> {
  await dispatchOutboxBatch(
    { db: kit.db.runtime.db },
    {
      subscriptions: [...orderCardUpdaterSubscriptions],
      claimedBy: "chat-test-dispatcher",
    },
  );
  const rows = await kit.db.runtime.db
    .select({ id: domainEvents.id, name: domainEvents.name })
    .from(domainEvents)
    .where(eq(domainEvents.aggregateId, orderId));
  const match = rows.find((row) => row.name === eventName);
  if (match === undefined) {
    throw new Error(`missing ${eventName} for ${orderId}`);
  }
  const subscription =
    eventName === "orders.created"
      ? orderCardUpdaterCreated
      : orderCardUpdaterConfirmed;
  await driveToProcessed(subscription, match.id);
  return match.id;
}

const baseCreateInput = {
  customer: { by: "id" as const, id: fixtures.customerA },
  items: [
    {
      product: { by: "id" as const, id: fixtures.pBase },
      quantity: { milli: "1000" },
    },
  ],
};

beforeAll(async () => {
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
  await insertProduct({
    id: fixtures.pBase,
    companyId: companyA,
    name: "Base",
    basePriceMinor: 500n,
  });
  await insertProduct({
    id: fixtures.pB,
    companyId: companyB,
    name: "Foreign",
    basePriceMinor: 100n,
  });
  await insertOrder({
    id: fixtures.orderIsolationA,
    companyId: companyA,
    customerId: fixtures.customerA,
    orderNumber: "T-1",
  });
  await insertOrder({
    id: fixtures.orderIsolationB,
    companyId: companyB,
    customerId: fixtures.customerB,
    orderNumber: "T-1",
  });
  await insertOrder({
    id: fixtures.orderConfirmFirst,
    companyId: companyA,
    customerId: fixtures.customerA,
    orderNumber: "T-2",
  });
  await kit.db.runtime.db.insert(orderCards).values([
    {
      id: fixtures.cardIsolationA,
      companyId: companyA,
      orderId: fixtures.orderIsolationA,
      revision: 1,
    },
    {
      id: fixtures.cardIsolationB,
      companyId: companyB,
      orderId: fixtures.orderIsolationB,
      revision: 1,
    },
  ]);
  await kit.db.runtime.db.insert(user).values({
    id: clerks.noChatView,
    name: "No chat view",
    email: "nochat@chat-kit.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.noChatView,
    role: "employee",
    permissions: { granted: [], denied: ["chat:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      getOrderCard,
      { input: { orderId: fixtures.orderIsolationA } },
      { input: { orderId: fixtures.orderIsolationB } },
    ),
    isolationCase(
      upsertOrderCard,
      {
        input: orderCardEnvelope({
          orderId: fixtures.orderIsolationA,
          name: "orders.created",
          companyId: kitIdentities.companies.a,
        }),
      },
      {
        input: orderCardEnvelope({
          orderId: fixtures.orderIsolationB,
          name: "orders.created",
          companyId: kitIdentities.companies.a,
        }),
      },
    ),
  ],
);

eventSuite(() => kit, {
  module: "chat",
  emitAction: createOrder,
  emitInput: baseCreateInput,
  failingEmitAction: emitCreatedThenFail,
  failingEmitInput: { orderId: randomUUID() },
  eventName: "orders.created",
  subscription: orderCardUpdaterCreated,
  readProjection: () => countCompanyCards(kitIdentities.companies.a),
});

describe("chat.getOrderCard / upsertOrderCard", () => {
  it("materializes revision 1 on create and bumps on confirm without storing order state", async () => {
    const created = await kit.invoke(createOrder, baseCreateInput);
    const createdEventId = await deliverNamedEvent(
      created.orderId,
      "orders.created",
    );

    const afterCreate = await kit.invoke(getOrderCard, {
      orderId: created.orderId,
    });
    expect(afterCreate.orderId).toBe(created.orderId);
    expect(afterCreate.revision).toBe(1);
    expect(typeof afterCreate.id).toBe("string");
    expect(typeof afterCreate.createdAt).toBe("string");
    expect(typeof afterCreate.updatedAt).toBe("string");
    expect(afterCreate).not.toHaveProperty("status");
    expect(afterCreate).not.toHaveProperty("totalGrossMinor");

    const createdRow = await loadCardRow(created.orderId);
    expect(createdRow?.id).toBe(afterCreate.id);
    expect(createdRow?.companyId).toBe(kitIdentities.companies.a);
    expect(createdRow?.orderId).toBe(created.orderId);
    expect(createdRow?.revision).toBe(1);
    expect(createdRow?.createdAt).toBeInstanceOf(Date);
    expect(createdRow?.updatedAt).toBeInstanceOf(Date);
    expect(createdRow).not.toHaveProperty("status");
    expect(createdRow).not.toHaveProperty("totalGrossMinor");

    await kit.invoke(confirmOrder, { orderId: created.orderId });
    const confirmedEventId = await deliverNamedEvent(
      created.orderId,
      "orders.confirmed",
    );

    const afterConfirm = await kit.invoke(getOrderCard, {
      orderId: created.orderId,
    });
    expect(afterConfirm.orderId).toBe(created.orderId);
    expect(afterConfirm.revision).toBe(2);
    expect(afterConfirm).not.toHaveProperty("status");
    expect(afterConfirm).not.toHaveProperty("totalGrossMinor");

    const confirmedRow = await loadCardRow(created.orderId);
    expect(confirmedRow?.revision).toBe(2);
    expect(confirmedRow).not.toHaveProperty("status");
    expect(confirmedRow).not.toHaveProperty("totalGrossMinor");

    const replayCreated = await executeDelivery(kit.pipeline, {
      subscription: orderCardUpdaterCreated,
      eventId: createdEventId,
      claimedBy: "chat-test-worker",
    });
    const replayConfirmed = await executeDelivery(kit.pipeline, {
      subscription: orderCardUpdaterConfirmed,
      eventId: confirmedEventId,
      claimedBy: "chat-test-worker",
    });
    expect(["alreadyProcessed", "processed"]).toContain(replayCreated.status);
    expect(["alreadyProcessed", "processed"]).toContain(replayConfirmed.status);
    const afterReplay = await kit.invoke(getOrderCard, {
      orderId: created.orderId,
    });
    expect(afterReplay.revision).toBe(2);

    const upsertAudit = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "chat.upsertOrderCard"),
          eq(auditLog.targetId, afterCreate.id),
        ),
      );
    expect(upsertAudit.length).toBeGreaterThanOrEqual(1);
    expect(upsertAudit[0]?.targetType).toBe("order-card");
    expect(upsertAudit[0]?.inputSnapshot).toBeNull();
  });

  it("denies missing chat:view and refuses a staff client upsert", async () => {
    await expect(
      kit.invoke(
        getOrderCard,
        { orderId: fixtures.orderIsolationA },
        { companyId: kitIdentities.companies.a, userId: clerks.noChatView },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      executeAction(kit.pipeline, {
        action: upsertOrderCard,
        input: orderCardEnvelope({
          orderId: fixtures.orderIsolationA,
          name: "orders.created",
          companyId: kitIdentities.companies.a,
        }),
        request: {
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
          idempotencyKey: randomUUID(),
        },
        principal: {
          mode: "staff",
          session: { userId: kitIdentities.users.anna },
          companySelector: kitIdentities.companies.a,
        },
      }),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("rejects invalid get input and missing cards with not-found", async () => {
    await expect(
      kit.invoke(getOrderCard, { orderId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const missing = randomUUID();
    const missingCard = await kit
      .invoke(getOrderCard, { orderId: missing })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    const foreignCard = await kit
      .invoke(getOrderCard, { orderId: fixtures.orderIsolationB })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (error: unknown) => error,
      );
    expect(missingCard).toBeInstanceOf(NotFoundError);
    expect(foreignCard).toBeInstanceOf(NotFoundError);
    if (
      missingCard instanceof NotFoundError &&
      foreignCard instanceof NotFoundError
    ) {
      expect(missingCard.clientMessage).toBe(foreignCard.clientMessage);
    }
  });

  it("upserts when confirm arrives before a card exists", async () => {
    const result = await kit.invoke(
      upsertOrderCard,
      orderCardEnvelope({
        orderId: fixtures.orderConfirmFirst,
        name: "orders.confirmed",
        companyId: kitIdentities.companies.a,
      }),
    );
    expect(result.applied).toBe(true);
    expect(result.revision).toBe(1);

    const card = await kit.invoke(getOrderCard, {
      orderId: fixtures.orderConfirmFirst,
    });
    expect(card.revision).toBe(1);
    expect(card.orderId).toBe(fixtures.orderConfirmFirst);
  });

  it("does not write another tenant's card from a foreign system scope", async () => {
    const before = await loadCardRow(fixtures.orderIsolationA);
    expect(before?.revision).toBeGreaterThanOrEqual(1);

    await expect(
      kit.invoke(
        upsertOrderCard,
        orderCardEnvelope({
          orderId: fixtures.orderIsolationA,
          name: "orders.created",
          companyId: kitIdentities.companies.a,
        }),
        { companyId: kitIdentities.companies.b },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const after = await loadCardRow(fixtures.orderIsolationA);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.companyId).toBe(kitIdentities.companies.a);
  });
});
