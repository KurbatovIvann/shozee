/**
 * Worker integration (fnd-T27): emit → dispatch → consumer processed;
 * LISTEN wakeup vs polling fallback; expired-claim reclaim exactly once;
 * one consumer id delivering two events (SHO-95); idempotency cleanup
 * removes expired keys only.
 */
import { randomUUID } from "node:crypto";

import {
  DELIVERY_CLAIM_MARGIN_MS,
  DELIVERY_DISCOVERY_BATCH_SIZE,
  defineEvent,
  defineEventHandler,
  dispatchOutboxBatch,
  eventEnvelopeSchema,
  executeDelivery,
  implementAction,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import { domainEvents, eventDeliveries, idempotencyKeys } from "@showzy/db";
import { and, asc, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createOutboxListener } from "./listen.js";
import { createOutboxWorker } from "./loop.js";
import { OUTBOX_NOTIFY_CHANNEL } from "./policy.js";

const silent = pino({ enabled: false });

const orderPlaced = defineEvent({
  name: "workerFixture.orderPlaced",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

const orderConfirmed = defineEvent({
  name: "workerFixture.orderConfirmed",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

const placeAction = implementAction(
  defineActionContract({
    name: "workerFixture.place",
    description: "Staff fixture emitting an order event into the outbox.",
    principal: "staff",
    transport: "internal",
    aiExposure: "internal",
    input: z.object({
      orderId: z.uuid(),
      count: z.number().int().positive().default(1),
    }),
    output: z.object({ ok: z.boolean() }),
    permissions: ["workerFixture:write"],
    risk: "write",
    requiresConfirmation: false,
    idempotent: false,
    emits: ["workerFixture.orderPlaced"],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      for (let index = 0; index < input.count; index += 1) {
        ctx.emit(orderPlaced, {
          aggregate: { type: "order", id: input.orderId },
          payload: { orderId: input.orderId },
        });
      }
      return Promise.resolve({ ok: true });
    },
    auditTarget: () => ({ type: "order", id: "fixture" }),
  },
);

const confirmAction = implementAction(
  defineActionContract({
    name: "workerFixture.confirm",
    description: "Staff fixture emitting an order-confirmed event.",
    principal: "staff",
    transport: "internal",
    aiExposure: "internal",
    input: z.object({ orderId: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    permissions: ["workerFixture:write"],
    risk: "write",
    requiresConfirmation: false,
    idempotent: false,
    emits: ["workerFixture.orderConfirmed"],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(orderConfirmed, {
        aggregate: { type: "order", id: input.orderId },
        payload: { orderId: input.orderId },
      });
      return Promise.resolve({ ok: true });
    },
    auditTarget: () => ({ type: "order", id: "fixture" }),
  },
);

const processedEventIds: string[] = [];

const upsertCardAction = implementAction(
  defineActionContract({
    name: "workerFixtureChat.upsertCard",
    description: "Chat-like consumer of the worker fixture event.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    aiExposure: "internal",
    input: eventEnvelopeSchema(z.object({ orderId: z.uuid() })),
    output: z.object({ ok: z.boolean() }),
    permissions: [],
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input) => {
      processedEventIds.push(input.eventId);
      return Promise.resolve({ ok: true });
    },
    auditTarget: () => ({ type: "order-card", id: "fixture" }),
  },
);

const cardSubscription = defineEventHandler({
  event: orderPlaced,
  consumer: "workerFixtureChat.card-updater",
  action: upsertCardAction,
});

const confirmedCardSubscription = defineEventHandler({
  event: orderConfirmed,
  consumer: "workerFixtureChat.card-updater",
  action: upsertCardAction,
});

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
});

afterAll(async () => {
  await kit.db.close();
});

function runtimeConnectionString(): string {
  const connectionString = kit.db.runtime.pool.options.connectionString;
  if (connectionString === undefined || connectionString === "") {
    throw new Error("runtime pool is missing a connection string");
  }
  return connectionString;
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for worker condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function deliveryStatus(eventId: string): Promise<string | undefined> {
  const [row] = await kit.db.runtime.db
    .select({ status: eventDeliveries.status })
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.consumer, cardSubscription.consumer),
        eq(eventDeliveries.eventId, eventId),
      ),
    );
  return row?.status;
}

async function emitOrder(): Promise<{ eventId: string }> {
  const orderId = randomUUID();
  await kit.invoke(placeAction, { orderId });
  const events = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(eq(domainEvents.aggregateId, orderId));
  const eventId = events[0]?.id;
  if (eventId === undefined || events.length !== 1) {
    throw new Error("expected exactly one emitted outbox row");
  }
  return { eventId };
}

async function emitConfirmedOrder(): Promise<{ eventId: string }> {
  const orderId = randomUUID();
  await kit.invoke(confirmAction, { orderId });
  const events = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(eq(domainEvents.aggregateId, orderId));
  const eventId = events[0]?.id;
  if (eventId === undefined || events.length !== 1) {
    throw new Error("expected exactly one emitted outbox row");
  }
  return { eventId };
}

describe("apps/worker outbox loop (core.md §6)", () => {
  it("wakes on LISTEN/NOTIFY and processes a delivery without waiting for poll", async () => {
    processedEventIds.length = 0;
    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: kit.pipeline,
      subscriptions: [cardSubscription],
      workerId: "worker-listen",
      logger: silent,
      pollIntervalMs: 60_000,
      listen: createOutboxListener({
        connectionString: runtimeConnectionString(),
        logger: silent,
      }),
    });
    await worker.start();
    try {
      const { eventId } = await emitOrder();
      await waitUntil(
        async () => (await deliveryStatus(eventId)) === "processed",
      );
      expect(processedEventIds).toEqual([eventId]);
    } finally {
      await worker.stop();
    }
  });

  it("processes a delivery via the polling fallback when LISTEN is not used", async () => {
    processedEventIds.length = 0;
    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: kit.pipeline,
      subscriptions: [cardSubscription],
      workerId: "worker-poll",
      logger: silent,
      pollIntervalMs: 50,
    });
    await worker.start();
    try {
      const { eventId } = await emitOrder();
      await waitUntil(
        async () => (await deliveryStatus(eventId)) === "processed",
      );
      expect(processedEventIds).toEqual([eventId]);
    } finally {
      await worker.stop();
    }
  });

  it("reclaims a killed worker's expired claim exactly once", async () => {
    processedEventIds.length = 0;
    const { eventId } = await emitOrder();
    await dispatchOutboxBatch(
      { db: kit.db.runtime.db },
      { subscriptions: [cardSubscription], claimedBy: "setup-dispatcher" },
    );

    let nowMs = Date.now();
    await kit.db.runtime.db
      .update(eventDeliveries)
      .set({
        status: "processing",
        attempts: 1,
        nextAttemptAt: null,
        claimedAt: new Date(nowMs),
        claimedBy: "killed-worker",
      })
      .where(
        and(
          eq(eventDeliveries.consumer, cardSubscription.consumer),
          eq(eventDeliveries.eventId, eventId),
        ),
      );

    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: { ...kit.pipeline, now: () => nowMs },
      subscriptions: [cardSubscription],
      workerId: "worker-reclaim",
      logger: silent,
      now: () => nowMs,
    });

    expect(await worker.tick()).toMatchObject({ processed: 0 });
    expect(processedEventIds).toHaveLength(0);
    expect(await deliveryStatus(eventId)).toBe("processing");

    nowMs += cardSubscription.contract.timeout + DELIVERY_CLAIM_MARGIN_MS;
    expect(await worker.tick()).toMatchObject({ processed: 1 });
    expect(processedEventIds).toEqual([eventId]);
    expect(await deliveryStatus(eventId)).toBe("processed");

    expect(await worker.tick()).toMatchObject({ processed: 0 });
    expect(processedEventIds).toEqual([eventId]);
    await worker.stop();
  });

  it("delivers two events to one consumer id through worker lookup", async () => {
    processedEventIds.length = 0;
    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: kit.pipeline,
      subscriptions: [cardSubscription, confirmedCardSubscription],
      workerId: "worker-multi-event",
      logger: silent,
      pollIntervalMs: 50,
    });
    await worker.start();
    try {
      const placed = await emitOrder();
      const confirmed = await emitConfirmedOrder();
      await waitUntil(async () => {
        const placedStatus = await deliveryStatus(placed.eventId);
        const confirmedStatus = await deliveryStatus(confirmed.eventId);
        return placedStatus === "processed" && confirmedStatus === "processed";
      });
      expect(processedEventIds).toEqual(
        expect.arrayContaining([placed.eventId, confirmed.eventId]),
      );
      expect(processedEventIds).toHaveLength(2);

      expect(
        await executeDelivery(kit.pipeline, {
          subscription: cardSubscription,
          eventId: placed.eventId,
          claimedBy: "worker-redelivery",
        }),
      ).toEqual({ status: "alreadyProcessed" });
      expect(
        await executeDelivery(kit.pipeline, {
          subscription: confirmedCardSubscription,
          eventId: confirmed.eventId,
          claimedBy: "worker-redelivery",
        }),
      ).toEqual({ status: "alreadyProcessed" });
      expect(processedEventIds).toHaveLength(2);
    } finally {
      await worker.stop();
    }
  });

  it("refuses to compose two bindings that share consumer and event", () => {
    expect(() =>
      createOutboxWorker({
        db: kit.db.runtime.db,
        pipeline: kit.pipeline,
        subscriptions: [cardSubscription, cardSubscription],
        workerId: "worker-duplicate",
        logger: silent,
      }),
    ).toThrow(CoreInvariantError);
  });

  it("cleanup removes expired idempotency keys only", async () => {
    const expiredKey = randomUUID();
    const liveKey = randomUUID();
    const nowMs = Date.now();
    await kit.db.runtime.db.insert(idempotencyKeys).values([
      {
        principalKey: `staff:${kit.identities.users.anna}`,
        scopeKey: `company:${kit.identities.companies.a}`,
        companyId: kit.identities.companies.a,
        action: "workerFixture.place",
        key: expiredKey,
        requestHash: "a".repeat(64),
        status: "completed",
        attemptId: randomUUID(),
        leaseExpiresAt: new Date(nowMs),
        expiresAt: new Date(nowMs - 1_000),
      },
      {
        principalKey: `staff:${kit.identities.users.anna}`,
        scopeKey: `company:${kit.identities.companies.a}`,
        companyId: kit.identities.companies.a,
        action: "workerFixture.place",
        key: liveKey,
        requestHash: "b".repeat(64),
        status: "completed",
        attemptId: randomUUID(),
        leaseExpiresAt: new Date(nowMs + 30_000),
        expiresAt: new Date(nowMs + 48 * 3_600_000),
      },
    ]);

    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: kit.pipeline,
      subscriptions: [cardSubscription],
      workerId: "worker-cleanup",
      logger: silent,
      now: () => nowMs,
    });
    expect(await worker.cleanup()).toBeGreaterThanOrEqual(1);

    const remaining = await kit.db.runtime.db
      .select({ key: idempotencyKeys.key })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.action, "workerFixture.place"));
    expect(remaining.map((row) => row.key)).toEqual([liveKey]);
    await worker.stop();
  });
});

describe("outbox notify channel", () => {
  it("matches the db.md §4 trigger channel", () => {
    expect(OUTBOX_NOTIFY_CHANNEL).toBe("domain_events");
  });
});

describe("apps/worker blocked-aggregate starvation (SHO-435)", () => {
  it("processes independent ready work within two ticks while successors stay blocked", async () => {
    processedEventIds.length = 0;
    const nowMs = Date.UTC(2026, 8, 5, 21, 0, 0);
    const blockedOrderId = randomUUID();
    await kit.invoke(placeAction, {
      orderId: blockedOrderId,
      count: DELIVERY_DISCOVERY_BATCH_SIZE + 1,
    });
    const independentOrderId = randomUUID();
    await kit.invoke(placeAction, { orderId: independentOrderId });

    for (;;) {
      const dispatched = await dispatchOutboxBatch(
        { db: kit.db.runtime.db, now: () => nowMs },
        {
          subscriptions: [cardSubscription],
          claimedBy: "starvation-dispatcher",
        },
      );
      if (dispatched.claimedEvents === 0) {
        break;
      }
    }

    const blockedEvents = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, blockedOrderId))
      .orderBy(asc(domainEvents.aggregateSequence));
    const independentEvents = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.aggregateId, independentOrderId));
    const predecessorEventId = blockedEvents[0]?.id;
    const successorEventIds = blockedEvents.slice(1).map((row) => row.id);
    const independentEventId = independentEvents[0]?.id;
    if (
      predecessorEventId === undefined ||
      independentEventId === undefined ||
      successorEventIds.length !== DELIVERY_DISCOVERY_BATCH_SIZE
    ) {
      throw new Error("worker starvation fixture was incomplete");
    }

    await kit.db.runtime.db
      .update(eventDeliveries)
      .set({
        status: "dead",
        attempts: 5,
        nextAttemptAt: null,
        lastError: "CONFLICT: parked predecessor.",
      })
      .where(
        and(
          eq(eventDeliveries.consumer, cardSubscription.consumer),
          eq(eventDeliveries.eventId, predecessorEventId),
        ),
      );

    const worker = createOutboxWorker({
      db: kit.db.runtime.db,
      pipeline: { ...kit.pipeline, now: () => nowMs },
      subscriptions: [cardSubscription],
      workerId: "worker-starvation",
      logger: silent,
      now: () => nowMs,
    });

    const firstTick = await worker.tick();
    expect(firstTick.processed).toBeGreaterThanOrEqual(1);
    expect(processedEventIds).toContain(independentEventId);
    for (const eventId of successorEventIds) {
      expect(processedEventIds).not.toContain(eventId);
    }

    await worker.tick();
    expect(
      processedEventIds.filter((id) => id === independentEventId),
    ).toHaveLength(1);
    for (const eventId of successorEventIds) {
      expect(await deliveryStatus(eventId)).toBe("pending");
    }
    await worker.stop();
  });
});
