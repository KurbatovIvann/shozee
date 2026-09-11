/**
 * The assistant's event plumbing against a real Redis (SHO-562).
 *
 * Presence and stream slots keep their deadlines by the Redis server's clock
 * inside Lua, so these tests never compare a host time with Redis time; an
 * expiry is proven with a zero ttl, not a sleep. Pub/sub ordering, isolation
 * and cleanup are asserted on the server itself (`PUBSUB NUMSUB`, `EXISTS`).
 */
import { randomUUID } from "node:crypto";

import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { Redis } from "ioredis";
import pino from "pino";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  ASSISTANT_PRESENCE_TTL_MS,
  ASSISTANT_STREAMS_PER_USER,
  assistantConversationChannel,
  assistantPresenceKey,
  type AssistantConversationAddress,
} from "../events.js";
import {
  createRedisAssistantEventHub,
  createRedisAssistantEventPublisher,
  createRedisAssistantPresence,
  createRedisAssistantStreamSlots,
  type AssistantEventHub,
  type AssistantEventListener,
} from "./assistant-events-redis.js";

let container: StartedRedisContainer;
let redis: Redis;
const hubs: AssistantEventHub[] = [];
const logger = pino({ level: "silent" });

beforeAll(async () => {
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

function newAddress(): AssistantConversationAddress {
  return { companyId: randomUUID(), conversationId: randomUUID() };
}

function hub(): AssistantEventHub {
  const created = createRedisAssistantEventHub(redis, { logger });
  hubs.push(created);
  return created;
}

function started(
  address: AssistantConversationAddress,
): AssistantPublishedEvent {
  return {
    type: "turn.started",
    conversationId: address.conversationId,
    kind: "chat",
    commandId: randomUUID(),
  };
}

async function subscribers(channel: string): Promise<number> {
  const reply = (await redis.call("PUBSUB", "NUMSUB", channel)) as [
    string,
    number,
  ];
  return reply[1];
}

/** A listener that resolves once it has heard `count` events. */
function collecting(count: number): AssistantEventListener & {
  readonly events: AssistantPublishedEvent[];
  readonly heard: Promise<AssistantPublishedEvent[]>;
  readonly lost: Promise<void>;
} {
  const events: AssistantPublishedEvent[] = [];
  let resolveHeard: (value: AssistantPublishedEvent[]) => void = () =>
    undefined;
  let resolveLost = (): void => undefined;
  const heard = new Promise<AssistantPublishedEvent[]>((resolve) => {
    resolveHeard = resolve;
  });
  const lost = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  return {
    events,
    heard,
    lost,
    onEvent(event) {
      events.push(event);
      if (events.length === count) {
        resolveHeard([...events]);
      }
    },
    onLost() {
      resolveLost();
    },
  };
}

describe("presence", () => {
  it("counts a stream once however often it is refreshed, and removes the key when the last one leaves", async () => {
    const presence = createRedisAssistantPresence(redis);
    const address = newAddress();

    await presence.enter(address, "stream-a");
    await presence.enter(address, "stream-a");
    await presence.enter(address, "stream-b");
    expect(await presence.watchers(address)).toBe(2);

    await presence.leave(address, "stream-a");
    expect(await presence.watchers(address)).toBe(1);
    await presence.leave(address, "stream-b");
    expect(await presence.watchers(address)).toBe(0);
    expect(await redis.exists(assistantPresenceKey(address))).toBe(0);
  });

  it("stops counting a stream whose deadline passed, and leaves no key behind", async () => {
    // A zero ttl is a deadline of "now" by the server's own clock: already
    // passed by the next command, with no wait and no host clock involved.
    const presence = createRedisAssistantPresence(redis, { ttlMs: 0 });
    const address = newAddress();

    await presence.enter(address, "stream-a");

    expect(await presence.watchers(address)).toBe(0);
    expect(await redis.exists(assistantPresenceKey(address))).toBe(0);
  });

  it("gives a stream the default 45 s deadline, which the key outlives", async () => {
    const presence = createRedisAssistantPresence(redis);
    const address = newAddress();

    await presence.enter(address, "stream-a");

    // Both sides of the comparison are Redis's clock: the deadline it set and
    // the ttl it reports.
    const ttl = await redis.pttl(assistantPresenceKey(address));
    expect(ASSISTANT_PRESENCE_TTL_MS).toBe(45_000);
    expect(ttl).toBeGreaterThan(44_000);
    expect(ttl).toBeLessThanOrEqual(45_001);
  });

  it("records and reads one key for mixed-case ids", async () => {
    const presence = createRedisAssistantPresence(redis);
    const address = newAddress();

    await presence.enter(
      {
        companyId: address.companyId.toUpperCase(),
        conversationId: address.conversationId.toUpperCase(),
      },
      "stream-a",
    );

    expect(await presence.watchers(address)).toBe(1);
  });
});

describe("stream slots", () => {
  it("refuses a stream beyond the limit, lets a held one refresh, and frees a slot on release", async () => {
    const slots = createRedisAssistantStreamSlots(redis, { limit: 2 });
    const userId = `user-${randomUUID()}`;

    expect(await slots.acquire(userId, "stream-a")).toBe(true);
    expect(await slots.acquire(userId, "stream-b")).toBe(true);
    expect(await slots.acquire(userId, "stream-c")).toBe(false);

    await slots.refresh(userId, "stream-a");
    expect(await slots.acquire(userId, "stream-c")).toBe(false);

    await slots.release(userId, "stream-a");
    expect(await slots.acquire(userId, "stream-c")).toBe(true);
  });

  it("refuses a person's sixth stream by default", async () => {
    const slots = createRedisAssistantStreamSlots(redis);
    const userId = `user-${randomUUID()}`;

    for (let stream = 1; stream <= 5; stream += 1) {
      expect(await slots.acquire(userId, `stream-${String(stream)}`)).toBe(
        true,
      );
    }

    expect(ASSISTANT_STREAMS_PER_USER).toBe(5);
    expect(await slots.acquire(userId, "stream-6")).toBe(false);
  });

  it("keeps one person's limit apart from another's", async () => {
    const slots = createRedisAssistantStreamSlots(redis, { limit: 1 });

    expect(await slots.acquire("user-a", "stream-a")).toBe(true);
    expect(await slots.acquire("user-b", "stream-b")).toBe(true);
  });

  it("gives back the slot of a stream that died without releasing it, once its deadline passes", async () => {
    const slots = createRedisAssistantStreamSlots(redis, {
      limit: 1,
      ttlMs: 0,
    });
    const userId = `user-${randomUUID()}`;

    expect(await slots.acquire(userId, "stream-crashed")).toBe(true);

    // At a limit of one, the only way in is past a member whose deadline is gone.
    expect(await slots.acquire(userId, "stream-next")).toBe(true);
  });
});

describe("the event hub", () => {
  it("fans one channel out to every listener, in publish order", async () => {
    const events = hub();
    const publisher = createRedisAssistantEventPublisher(redis);
    const address = newAddress();
    const first = collecting(3);
    const second = collecting(3);
    await events.subscribe(address, first);
    await events.subscribe(address, second);
    const sent = [started(address), started(address), started(address)];

    for (const event of sent) {
      await publisher.publish(address, event);
    }

    expect(await first.heard).toEqual(sent);
    expect(await second.heard).toEqual(sent);
  });

  it("hears a publish addressed with the lowercase ids the worker holds on a subscription made with mixed-case ones", async () => {
    const events = hub();
    const publisher = createRedisAssistantEventPublisher(redis);
    const address = newAddress();
    const listener = collecting(1);
    await events.subscribe(
      {
        companyId: address.companyId.toUpperCase(),
        conversationId: address.conversationId.toUpperCase(),
      },
      listener,
    );
    const event = started(address);

    await publisher.publish(address, event);

    expect(await listener.heard).toEqual([event]);
  });

  it("delivers nothing from the same conversation id in another company", async () => {
    const events = hub();
    const publisher = createRedisAssistantEventPublisher(redis);
    const address = newAddress();
    const elsewhere = { ...address, companyId: randomUUID() };
    const listener = collecting(1);
    await events.subscribe(address, listener);
    const mine = started(address);

    // Published first, so it would arrive first if it arrived at all.
    await publisher.publish(elsewhere, started(elsewhere));
    await publisher.publish(address, mine);

    expect(await listener.heard).toEqual([mine]);
  });

  it("drops a channel message it cannot read and keeps delivering", async () => {
    const events = hub();
    const publisher = createRedisAssistantEventPublisher(redis);
    const address = newAddress();
    const listener = collecting(1);
    await events.subscribe(address, listener);
    const readable = started(address);

    await redis.publish(assistantConversationChannel(address), "{not json");
    await publisher.publish(address, readable);

    expect(await listener.heard).toEqual([readable]);
  });

  it("holds one Redis subscription per channel, and none once the last listener leaves", async () => {
    const events = hub();
    const address = newAddress();
    const channel = assistantConversationChannel(address);

    const first = await events.subscribe(address, collecting(1));
    const second = await events.subscribe(address, collecting(1));
    expect(await subscribers(channel)).toBe(1);

    await first.close();
    expect(await subscribers(channel)).toBe(1);
    await second.close();
    expect(await subscribers(channel)).toBe(0);
  });

  it("tells its listeners when the subscriber connection drops, since what was published meanwhile is gone", async () => {
    const events = hub();
    const address = newAddress();
    const listener = collecting(1);
    await events.subscribe(address, listener);

    await redis.call("CLIENT", "KILL", "TYPE", "pubsub");

    await listener.lost;
  });

  it("subscribes again after a dropped connection, without resubscribing what it had", async () => {
    const events = hub();
    const publisher = createRedisAssistantEventPublisher(redis);
    const address = newAddress();
    const before = collecting(1);
    await events.subscribe(address, before);
    await redis.call("CLIENT", "KILL", "TYPE", "pubsub");
    await before.lost;

    const after = collecting(1);
    await events.subscribe(address, after);
    const event = started(address);
    await publisher.publish(address, event);

    expect(await after.heard).toEqual([event]);
    expect(before.events).toEqual([]);
  });
});
