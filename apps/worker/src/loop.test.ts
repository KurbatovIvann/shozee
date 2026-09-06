import {
  defineEvent,
  defineEventHandler,
  eventEnvelopeSchema,
  implementAction,
  type ClaimableDelivery,
} from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { pino, type Logger } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  consumerEventKey,
  createWorkerLoop,
  indexSubscriptionsByConsumerEvent,
  type TickResult,
} from "./loop.js";

const silent = pino({ enabled: false });

function captureLogger(): {
  logger: Logger;
  entries: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = pino(
    { base: null },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  return {
    logger,
    entries: () =>
      lines
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function emptyTick(): TickResult {
  return {
    claimedEvents: 0,
    createdDeliveries: 0,
    processed: 0,
    alreadyProcessed: 0,
    deferred: 0,
    failed: 0,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for worker loop condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createWorkerLoop", () => {
  it("coalesces overlapping ticks into one follow-up run", async () => {
    const gates: Array<
      (result: { claimedEvents: number; createdDeliveries: number }) => void
    > = [];
    let dispatchCount = 0;
    const loop = createWorkerLoop({
      workerId: "coalesce",
      logger: silent,
      pollIntervalMs: 60_000,
      dispatch: () => {
        dispatchCount += 1;
        return new Promise((resolve) => {
          gates.push(resolve);
        });
      },
      findDue: () => Promise.resolve([]),
      execute: () => Promise.resolve({ status: "processed" }),
      cleanup: () => Promise.resolve(0),
    });

    const first = loop.tick();
    await waitFor(() => dispatchCount === 1);
    void loop.tick();
    void loop.tick();
    const firstGate = gates[0];
    if (firstGate === undefined) {
      throw new Error("expected a blocked dispatch");
    }
    firstGate({ claimedEvents: 0, createdDeliveries: 0 });
    await waitFor(() => dispatchCount === 2);
    const secondGate = gates[1];
    if (secondGate === undefined) {
      throw new Error("expected the coalesced dispatch");
    }
    secondGate({ claimedEvents: 0, createdDeliveries: 0 });
    await first;
    expect(dispatchCount).toBe(2);
    await loop.stop();
  });

  it("drains an in-flight execute before stop resolves", async () => {
    const delivery: ClaimableDelivery = {
      consumer: "fixture.consumer",
      eventId: "11111111-1111-4111-8111-111111111111",
      eventName: "fixture.happened",
    };
    let release: ((outcome: { status: "processed" }) => void) | undefined;
    let executing = 0;
    const loop = createWorkerLoop({
      workerId: "drain",
      logger: silent,
      pollIntervalMs: 60_000,
      dispatch: () =>
        Promise.resolve({ claimedEvents: 0, createdDeliveries: 0 }),
      findDue: () => Promise.resolve([delivery]),
      execute: () => {
        executing += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      cleanup: () => Promise.resolve(0),
    });

    const ticking = loop.tick();
    await waitFor(() => executing === 1);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    if (release === undefined) {
      throw new Error("expected an in-flight execute");
    }
    release({ status: "processed" });
    await stopping;
    await ticking;
    expect(stopped).toBe(true);
    expect(executing).toBe(1);
  });

  it("does not claim further work after stop", async () => {
    let executed = 0;
    const loop = createWorkerLoop({
      workerId: "stopped",
      logger: silent,
      pollIntervalMs: 60_000,
      dispatch: () =>
        Promise.resolve({ claimedEvents: 1, createdDeliveries: 1 }),
      findDue: () =>
        Promise.resolve([
          {
            consumer: "fixture.consumer",
            eventId: "11111111-1111-4111-8111-111111111111",
            eventName: "fixture.happened",
          },
        ]),
      execute: () => {
        executed += 1;
        return Promise.resolve({ status: "processed" });
      },
      cleanup: () => Promise.resolve(0),
    });

    await loop.stop();
    expect(await loop.tick()).toEqual(emptyTick());
    expect(executed).toBe(0);
  });

  it("survives a transient dispatch failure: logs, backs off, keeps ticking (SHO-279)", async () => {
    let clock = 0;
    let dispatchCalls = 0;
    let failing = true;
    const { logger, entries } = captureLogger();
    const loop = createWorkerLoop({
      workerId: "survive",
      logger,
      pollIntervalMs: 1_000,
      now: () => clock,
      dispatch: () => {
        dispatchCalls += 1;
        if (failing) {
          return Promise.reject(new Error("transient db error"));
        }
        return Promise.resolve({ claimedEvents: 0, createdDeliveries: 0 });
      },
      findDue: () => Promise.resolve([]),
      execute: () => Promise.resolve({ status: "processed" }),
      cleanup: () => Promise.resolve(0),
    });

    // The failure resolves (never rejects) and logs with backoff metadata.
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(1);
    const failureLogs = entries().filter(
      (entry) => entry["msg"] === "outbox tick failed",
    );
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0]?.["consecutive_failures"]).toBe(1);
    expect(failureLogs[0]?.["backoff_ms"]).toBe(1_000);

    // Inside the backoff window ticks are skipped — no dispatch hammering.
    clock = 500;
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(1);

    // After the window a failing tick doubles the backoff…
    clock = 1_000;
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(2);
    const secondFailure = entries().filter(
      (entry) => entry["msg"] === "outbox tick failed",
    )[1];
    expect(secondFailure?.["consecutive_failures"]).toBe(2);
    expect(secondFailure?.["backoff_ms"]).toBe(2_000);

    // …and a recovered tick resets the failure counter and backoff.
    failing = false;
    clock = 3_000;
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(3);
    clock = 3_001;
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(4);

    // Graceful shutdown still works after failures.
    await loop.stop();
    expect(await loop.tick()).toEqual(emptyTick());
    expect(dispatchCalls).toBe(4);
  });

  it("caps the failure backoff at TICK_FAILURE_BACKOFF_MAX_MS", async () => {
    let clock = 0;
    const { logger, entries } = captureLogger();
    const loop = createWorkerLoop({
      workerId: "backoff-cap",
      logger,
      pollIntervalMs: 20_000,
      now: () => clock,
      dispatch: () => Promise.reject(new Error("still down")),
      findDue: () => Promise.resolve([]),
      execute: () => Promise.resolve({ status: "processed" }),
      cleanup: () => Promise.resolve(0),
    });

    await loop.tick(); // 20 000 (uncapped first step)
    clock = 20_000;
    await loop.tick(); // 40 000 → capped to 30 000
    const backoffs = entries()
      .filter((entry) => entry["msg"] === "outbox tick failed")
      .map((entry) => entry["backoff_ms"]);
    expect(backoffs).toEqual([20_000, 30_000]);
    await loop.stop();
  });

  it("executes deliveries concurrently: a fast one never waits on a slow one (SHO-279)", async () => {
    const slow: ClaimableDelivery = {
      consumer: "fixture.slow",
      eventId: "11111111-1111-4111-8111-111111111111",
      eventName: "fixture.happened",
    };
    const fast: ClaimableDelivery = {
      consumer: "fixture.fast",
      eventId: "22222222-2222-4222-8222-222222222222",
      eventName: "fixture.happened",
    };
    let releaseSlow: ((outcome: { status: "processed" }) => void) | undefined;
    const completed: string[] = [];
    const loop = createWorkerLoop({
      workerId: "concurrent",
      logger: silent,
      pollIntervalMs: 60_000,
      deliveryConcurrency: 2,
      dispatch: () =>
        Promise.resolve({ claimedEvents: 0, createdDeliveries: 0 }),
      findDue: () => Promise.resolve([slow, fast]),
      execute: (delivery) => {
        if (delivery.consumer === slow.consumer) {
          return new Promise((resolve) => {
            releaseSlow = (outcome) => {
              completed.push(delivery.consumer);
              resolve(outcome);
            };
          });
        }
        completed.push(delivery.consumer);
        return Promise.resolve({ status: "processed" });
      },
      cleanup: () => Promise.resolve(0),
    });

    const ticking = loop.tick();
    // The fast delivery finishes while the slow one is still in flight —
    // proof the pool is concurrent, not head-of-line blocked.
    await waitFor(() => completed.includes(fast.consumer));
    expect(completed).toEqual([fast.consumer]);
    expect(releaseSlow).toBeDefined();
    releaseSlow?.({ status: "processed" });
    const result = await ticking;
    expect(result.processed).toBe(2);
    expect(completed).toEqual([fast.consumer, slow.consumer]);
    await loop.stop();
  });

  it("runs deliveries sequentially when deliveryConcurrency is 1", async () => {
    const order: string[] = [];
    const deliveries: ClaimableDelivery[] = ["a", "b", "c"].map(
      (name, index) => ({
        consumer: `fixture.${name}`,
        eventId: `33333333-3333-4333-8333-33333333333${String(index + 1)}`,
        eventName: "fixture.happened",
      }),
    );
    const loop = createWorkerLoop({
      workerId: "sequential",
      logger: silent,
      pollIntervalMs: 60_000,
      deliveryConcurrency: 1,
      dispatch: () =>
        Promise.resolve({ claimedEvents: 0, createdDeliveries: 0 }),
      findDue: () => Promise.resolve(deliveries),
      execute: (delivery) => {
        order.push(delivery.consumer);
        return Promise.resolve({ status: "processed" });
      },
      cleanup: () => Promise.resolve(0),
    });

    const result = await loop.tick();
    expect(result.processed).toBe(3);
    expect(order).toEqual(["fixture.a", "fixture.b", "fixture.c"]);
    await loop.stop();
  });

  it("does not run idempotency cleanup from the outbox loop", async () => {
    let cleanups = 0;
    const loop = createWorkerLoop({
      workerId: "no-cleanup-timer",
      logger: silent,
      pollIntervalMs: 60_000,
      dispatch: () =>
        Promise.resolve({ claimedEvents: 0, createdDeliveries: 0 }),
      findDue: () => Promise.resolve([]),
      execute: () => Promise.resolve({ status: "processed" }),
      cleanup: () => {
        cleanups += 1;
        return Promise.resolve(0);
      },
    });

    await loop.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleanups).toBe(0);
    await loop.stop();
  });
});

const placed = defineEvent({
  name: "loopFixture.placed",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

const confirmed = defineEvent({
  name: "loopFixture.confirmed",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

const upsertAction = implementAction(
  defineActionContract({
    name: "loopFixtureChat.upsertCard",
    description: "Same system action bound to two events.",
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
    handler: () => Promise.resolve({ ok: true }),
    auditTarget: () => ({ type: "order-card", id: "fixture" }),
  },
);

const placedBinding = defineEventHandler({
  event: placed,
  consumer: "loopFixtureChat.card-updater",
  action: upsertAction,
});

const confirmedBinding = defineEventHandler({
  event: confirmed,
  consumer: "loopFixtureChat.card-updater",
  action: upsertAction,
});

describe("indexSubscriptionsByConsumerEvent (core.md §6)", () => {
  it("keeps two same-consumer bindings when their events differ", () => {
    const indexed = indexSubscriptionsByConsumerEvent([
      placedBinding,
      confirmedBinding,
    ]);
    expect(indexed.size).toBe(2);
    expect(
      indexed.get(consumerEventKey(placedBinding.consumer, placed.name)),
    ).toBe(placedBinding);
    expect(
      indexed.get(consumerEventKey(confirmedBinding.consumer, confirmed.name)),
    ).toBe(confirmedBinding);
    expect(indexed.get(placedBinding.consumer)).toBeUndefined();
  });

  it("fails closed on a duplicate (consumer, event) binding", () => {
    expect(() =>
      indexSubscriptionsByConsumerEvent([placedBinding, placedBinding]),
    ).toThrow(CoreInvariantError);
  });
});
