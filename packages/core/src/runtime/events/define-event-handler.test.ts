/**
 * Unit tests for `defineEventHandler` and the envelope schema builder
 * (fnd-T17 — core.md §6).
 *
 * Define-time binding validation mirrors the registry-wide subscription
 * rules of the contract check (fnd-T10): system-principal,
 * transport-internal, AI-internal, write, idempotent, systemScope matching
 * the event scope, and a stable `<module>.<kebab-name>` consumer id. All
 * violations are reported at once.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { runContractCheck } from "../../contract-check/contract-check.js";
import { emptySuiteCoverage } from "../../contract-check/suite-coverage.js";
import { ActionRegistry } from "../action-registry.js";
import { implementAction } from "../implement-action.js";
import { defineEvent } from "./define-event.js";
import {
  defineEventHandler,
  EventHandlerDefinitionError,
  eventSubscriptionRefs,
} from "./define-event-handler.js";
import { eventEnvelopeSchema } from "./envelope.js";

const orderPlaced = defineEvent({
  name: "handlerFixture.orderPlaced",
  version: 1,
  scope: "tenant",
  payload: z.object({ orderId: z.uuid() }),
});

const sweepCompleted = defineEvent({
  name: "handlerFixture.sweepCompleted",
  version: 1,
  scope: "global",
  payload: z.object({ scanned: z.number().int() }),
});

const consumerContract = defineActionContract({
  name: "handlerFixtureChat.upsertCard",
  description: "Valid consumer fixture for orderPlaced deliveries.",
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
});

const consumerAction = implementAction(consumerContract, {
  handler: () => Promise.resolve({ ok: true }),
  auditTarget: () => ({ type: "order-card", id: "fixture" }),
});

// Constructible at define time (staff may be client-transport, exposed,
// read, non-idempotent) while violating every §6 binding rule at once.
const wrongEverythingContract = defineActionContract({
  name: "handlerFixtureChat.listCards",
  description: "Fixture violating every subscription binding rule.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permissions: ["handlerFixtureChat:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  audit: false,
  timeout: 5_000,
});

const wrongEverythingAction = implementAction(wrongEverythingContract, {
  handler: () => Promise.resolve({ ok: true }),
});

describe("defineEventHandler — valid bindings", () => {
  it("accepts a rule-conforming binding and freezes it", () => {
    const subscription = defineEventHandler({
      event: orderPlaced,
      consumer: "handlerFixtureChat.order-card-updater",
      action: consumerAction,
    });

    expect(subscription.event).toBe(orderPlaced);
    expect(subscription.consumer).toBe("handlerFixtureChat.order-card-updater");
    expect(subscription.contract).toBe(consumerContract);
    expect(Object.isFrozen(subscription)).toBe(true);
  });

  it("maps subscriptions to contract-check refs", () => {
    const subscription = defineEventHandler({
      event: orderPlaced,
      consumer: "handlerFixtureChat.order-card-updater",
      action: consumerAction,
    });

    expect(eventSubscriptionRefs([subscription])).toEqual([
      {
        event: "handlerFixture.orderPlaced",
        consumer: "handlerFixtureChat.order-card-updater",
        action: "handlerFixtureChat.upsertCard",
      },
    ]);
  });

  it("produces refs the registry-wide contract check accepts", () => {
    const registry = new ActionRegistry();
    registry.registerContract(consumerContract);
    registry.registerImplementation(consumerAction);
    const subscription = defineEventHandler({
      event: orderPlaced,
      consumer: "handlerFixtureChat.order-card-updater",
      action: consumerAction,
    });

    const result = runContractCheck({
      registry,
      events: [orderPlaced],
      subscriptions: eventSubscriptionRefs([subscription]),
      callEdges: [],
      projectionGrants: new Set<string>(),
      readModelGrants: [],
      schemaImports: [],
      schemaTables: [],
      suiteCoverage: {
        ...emptySuiteCoverage,
        isolation: ["handlerFixtureChat.upsertCard"],
        events: ["handlerFixtureChat"],
      },
    });

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("defineEventHandler — rejections (core.md §6)", () => {
  it("rejects unstable consumer names", () => {
    for (const consumer of [
      "order-card-updater", // no module segment
      "chat.OrderCardUpdater", // camelCase consumer segment
      "chat.order_card", // underscore
      "chat.", // empty consumer segment
      "Chat.order-card-updater", // capitalized module
      "chat.order-card-", // trailing dash
    ]) {
      expect(() =>
        defineEventHandler({
          event: orderPlaced,
          consumer,
          action: consumerAction,
        }),
      ).toThrow(EventHandlerDefinitionError);
    }
  });

  it("lists every violated binding rule at once", () => {
    let thrown: EventHandlerDefinitionError | undefined;
    try {
      defineEventHandler({
        event: orderPlaced,
        consumer: "handlerFixtureChat.card-lister",
        action: wrongEverythingAction,
      });
    } catch (error) {
      if (!(error instanceof EventHandlerDefinitionError)) throw error;
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const problems = thrown?.problems.join("\n") ?? "";
    expect(problems).toContain("must be system-principal");
    expect(problems).toContain("must be transport-internal");
    expect(problems).toContain("must be AI-internal");
    expect(problems).toContain('must declare risk: "write"');
    expect(problems).toContain("must be idempotent");
  });

  it("rejects a systemScope that does not match the event scope", () => {
    expect(() =>
      defineEventHandler({
        event: sweepCompleted, // global event, tenant-scoped consumer action
        consumer: "handlerFixtureChat.sweep-follower",
        action: consumerAction,
      }),
    ).toThrow(/systemScope "tenant".*global-scoped/);
  });
});

describe("eventEnvelopeSchema", () => {
  const schema = eventEnvelopeSchema(z.object({ orderId: z.uuid() }));
  const orderId = "0198da2e-1111-7abc-8def-0123456789ab";
  const envelope = {
    eventId: "0198da2e-2222-7abc-8def-0123456789ab",
    name: "handlerFixture.orderPlaced",
    version: 1,
    occurredAt: "2026-08-18T10:00:00.000Z",
    companyId: "0198da2e-3333-7abc-8def-0123456789ab",
    aggregate: { type: "order", id: orderId, sequence: "1" },
    actor: { type: "user", id: "user_1", channel: "ui" },
    requestId: "req-1",
    correlationId: "corr-1",
    causationId: "req-1",
    payload: { orderId },
  };

  it("accepts the delivered envelope shape, including a null company", () => {
    expect(schema.parse(envelope)).toEqual(envelope);
    expect(schema.parse({ ...envelope, companyId: null }).companyId).toBeNull();
  });

  it("rejects non-JSON-safe variants (Date, bigint sequence)", () => {
    expect(
      schema.safeParse({ ...envelope, occurredAt: new Date() }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...envelope,
        aggregate: { ...envelope.aggregate, sequence: 1n },
      }).success,
    ).toBe(false);
  });

  it("validates the payload against the consumed event's schema", () => {
    expect(
      schema.safeParse({ ...envelope, payload: { orderId: "not-a-uuid" } })
        .success,
    ).toBe(false);
  });
});
