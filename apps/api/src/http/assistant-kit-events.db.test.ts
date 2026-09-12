/**
 * `GET /assistant/kit/events` against a real database and a real Redis
 * (SHO-562).
 *
 * The conversation, its messages and their revisions are Postgres, written the
 * way a turn writes them (the T2 accept and the kit's update). The channel,
 * presence and stream slots are Redis. The session is the only fake: it is the
 * better-auth instance's job, and this suite is about what the route does with
 * the answer.
 *
 * Nothing waits on a clock. Heartbeats and idle closes fire when a test fires
 * them, and cleanup is awaited through the stream registry, then checked on the
 * Redis server itself.
 */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  assistantConversationChannel,
  assistantPresenceKey,
  assistantStreamSlotsKey,
  assistantTurnMessageId,
  createMemoryAiBudgetStore,
  createPostgresAssistantTurnStore,
  createRedisAssistantEventHub,
  createRedisAssistantEventPublisher,
  createRedisAssistantPresence,
  createRedisAssistantStreamSlots,
  type AssistantConversationAddress,
  type AssistantEventHub,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { createInMemoryRateLimitStore } from "@showzy/core";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  assistantChatMessages,
  assistantConversations,
} from "@showzy/db/schema/assistant";
import {
  parseAssistantStreamEvent,
  type AssistantStreamEvent,
} from "@showzy/validation/assistant-events";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createActionRegistry } from "../registry.js";
import {
  ASSISTANT_KIT_CHAT_PATH,
  ASSISTANT_KIT_EVENTS_PATH,
  ASSISTANT_KIT_MESSAGES_PATH,
  createAssistantKitApp,
  type AssistantKitBudget,
} from "./assistant-kit.js";
import {
  createAssistantKitEvents,
  type AssistantKitEvents,
  type AssistantKitStreamTimers,
} from "./assistant-kit-events.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";

let kit: TestKit;
let container: StartedRedisContainer;
let redis: Redis;
const registry = createActionRegistry();

const COMPANY = kitIdentities.companies.a;
const anna = {
  userId: kitIdentities.users.anna,
  companySelector: COMPANY,
  requestId: randomUUID(),
  clientIp: "127.0.0.1",
};
const annaBind = `${anna.userId}:${COMPANY}`;

beforeAll(async () => {
  kit = await createTestKit();
  container = await new RedisContainer("redis:8-alpine").start();
  redis = new Redis(container.getConnectionUrl());
}, 180_000);

afterAll(async () => {
  await redis.quit();
  await container.stop();
  await kit.db.close();
});

beforeEach(async () => {
  await redis.flushall();
});

/** Fired by the test, never by a clock. */
interface ManualTimers extends AssistantKitStreamTimers {
  /** Resolves once a stream has armed its heartbeat: it has fully started. */
  readonly armed: Promise<void>;
  /** One whole heartbeat of every open stream. */
  beat(): Promise<void>;
  idle(): void;
}

function manualTimers(): ManualTimers {
  const beats = new Set<() => Promise<void>>();
  const idles = new Set<() => void>();
  let arm = (): void => undefined;
  const armed = new Promise<void>((resolve) => {
    arm = resolve;
  });
  return {
    armed,
    every(_ms, tick) {
      beats.add(tick);
      arm();
      return () => {
        beats.delete(tick);
      };
    },
    after(_ms, fire) {
      idles.add(fire);
      return () => {
        idles.delete(fire);
      };
    },
    async beat() {
      await Promise.all([...beats].map((tick) => tick()));
    },
    idle() {
      for (const fire of [...idles]) {
        fire();
      }
    },
  };
}

interface Harness {
  readonly app: ReturnType<typeof createAssistantKitApp>;
  readonly events: AssistantKitEvents;
  readonly timers: ManualTimers;
  readonly runtime: ReturnType<typeof createAssistantKitRuntime>;
  signOut(): void;
  /**
   * Makes the next session checks wait. `asked` resolves once one is waiting;
   * `release` lets them answer.
   */
  holdSession(): { readonly asked: Promise<void>; release(): void };
}

const open: {
  readonly events: AssistantKitEvents;
  readonly hub: AssistantEventHub;
}[] = [];

afterEach(async () => {
  for (const { events, hub } of open.splice(0)) {
    await events.streams.closeAll();
    await hub.close();
  }
});

function harness(options?: {
  readonly streamsPerUser?: number;
  readonly budget?: AssistantKitBudget;
}): Harness {
  let session: { user: { id: string }; session: { id: string } } | null = {
    user: { id: anna.userId },
    session: { id: "session-1" },
  };
  let hold: { readonly until: Promise<void>; asked(): void } | null = null;
  const runtime = createAssistantKitRuntime({
    auth: {
      api: {
        getSession: async () => {
          if (hold !== null) {
            hold.asked();
            await hold.until;
          }
          return session;
        },
      },
    },
    registry,
    pipeline: kit.pipeline,
    model: "mock",
    redis,
  });
  const timers = manualTimers();
  const hub = createRedisAssistantEventHub(redis, {
    logger: kit.pipeline.logger,
  });
  const events = createAssistantKitEvents({
    hub,
    presence: createRedisAssistantPresence(redis),
    slots: createRedisAssistantStreamSlots(redis, {
      limit: options?.streamsPerUser ?? 5,
    }),
    timers,
  });
  open.push({ events, hub });
  return {
    app: createAssistantKitApp(runtime, options?.budget, events),
    events,
    timers,
    runtime,
    signOut() {
      session = null;
    },
    holdSession() {
      let markAsked = (): void => undefined;
      let release = (): void => undefined;
      const asked = new Promise<void>((resolve) => {
        markAsked = resolve;
      });
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = {
        until,
        asked: () => {
          markAsked();
        },
      };
      return {
        asked,
        release() {
          hold = null;
          release();
        },
      };
    },
  };
}

function companyHeaders(company: string = COMPANY): Record<string, string> {
  return { [COMPANY_SELECTOR_HEADER]: company };
}

function addressOf(conversationId: string): AssistantConversationAddress {
  return { companyId: COMPANY, conversationId };
}

async function newConversation(
  owner: { companyId: string; userId: string } = {
    companyId: COMPANY,
    userId: anna.userId,
  },
): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db
    .insert(assistantConversations)
    .values({ id, ...owner });
  return id;
}

/** A conversation holding what an accepted turn stores: a question and a placeholder. */
async function conversationWithTurn(): Promise<{
  readonly conversationId: string;
  readonly commandId: string;
  readonly placeholderId: string;
}> {
  const conversationId = await newConversation();
  const commandId = randomUUID();
  const accepted = await createPostgresAssistantTurnStore(
    { pipeline: kit.pipeline },
    anna,
  ).accept({
    kind: "chat",
    conversationId,
    commandId,
    bind: annaBind,
    text: "створи замовлення",
    sessionId: "session-anna",
    budgetHold: {
      companyReservedUsd: 0.1,
      globalReservedUsd: 0.1,
      kyivDate: "2026-09-11",
    },
    releaseUnusedHold: () => Promise.resolve(),
  });
  expect(accepted.outcome).toBe("accepted");
  return {
    conversationId,
    commandId,
    placeholderId: assistantTurnMessageId(
      { kind: "chat", commandId },
      "assistant",
    ),
  };
}

/** What a worker does to the live message: one update, one revision up. */
async function updatePlaceholder(
  h: Harness,
  conversationId: string,
  placeholderId: string,
): Promise<void> {
  await h.runtime.forCaller(anna).kit.messages.write(
    { conversationId, bind: annaBind },
    {
      kind: "append",
      messageId: placeholderId,
      role: "assistant",
      parts: [{ kind: "text", text: "Готово.", status: "complete" }],
    },
  );
}

async function storedRevision(messageId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ revision: assistantChatMessages.revision })
    .from(assistantChatMessages)
    .where(eq(assistantChatMessages.messageId, messageId));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`no stored message ${messageId}`);
  }
  return row.revision;
}

async function messagesWindow(
  h: Harness,
  conversationId: string,
): Promise<unknown> {
  const response = await h.app.request(
    `${ASSISTANT_KIT_MESSAGES_PATH}?conversationId=${conversationId}`,
    { headers: companyHeaders() },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly window: unknown };
  return body.window;
}

interface Frame {
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

interface EventReader {
  /** The next frame, or `null` once the server has ended the stream. */
  next(): Promise<Frame | null>;
  cancel(): Promise<void>;
}

function eventReader(response: Response): EventReader {
  if (response.body === null) {
    throw new Error("an event stream has a body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return parseFrame(block);
        }
        const chunk = await reader.read();
        if (chunk.done) {
          return null;
        }
        buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function parseFrame(block: string): Frame {
  let event: string | undefined;
  const data: string[] = [];
  let comment: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      comment = line.slice(1).trim();
    } else if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      data.push(line.slice("data: ".length));
    }
  }
  return {
    ...(event === undefined ? {} : { event }),
    ...(data.length === 0 ? {} : { data: data.join("\n") }),
    ...(comment === undefined ? {} : { comment }),
  };
}

async function nextEvent(reader: EventReader): Promise<AssistantStreamEvent> {
  const frame = await reader.next();
  if (frame?.event === undefined || frame.data === undefined) {
    throw new Error(`expected an event, got ${JSON.stringify(frame)}`);
  }
  const event = parseAssistantStreamEvent(frame.event, frame.data);
  if (event === null) {
    throw new Error(`unreadable ${frame.event} event: ${frame.data}`);
  }
  return event;
}

function eventsPath(conversationId: string): string {
  return `${ASSISTANT_KIT_EVENTS_PATH}?conversationId=${conversationId}`;
}

async function openStream(
  h: Harness,
  conversationId: string,
): Promise<EventReader> {
  const response = await h.app.request(eventsPath(conversationId), {
    headers: companyHeaders(),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return eventReader(response);
}

async function subscribers(channel: string): Promise<number> {
  const reply = (await redis.call("PUBSUB", "NUMSUB", channel)) as [
    string,
    number,
  ];
  return reply[1];
}

/** Every key this feature writes, across conversations and people. */
async function assistantEventKeys(): Promise<string[]> {
  return [
    ...(await redis.keys("assistant:presence:*")),
    ...(await redis.keys("assistant:streams:*")),
  ];
}

describe("who may subscribe", () => {
  it("answers a foreign author, a foreign company, a missing conversation and a company the caller is not in exactly as the messages route does, and leaves nothing in Redis", async () => {
    const h = harness();
    const cases = [
      {
        name: "another author in the caller's company",
        conversationId: await newConversation({
          companyId: COMPANY,
          userId: kitIdentities.users.boris,
        }),
        company: COMPANY,
      },
      {
        name: "the caller's own conversation in another company",
        conversationId: await newConversation({
          companyId: kitIdentities.companies.b,
          userId: anna.userId,
        }),
        company: COMPANY,
      },
      {
        name: "a conversation that does not exist",
        conversationId: randomUUID(),
        company: COMPANY,
      },
      {
        name: "a company the caller is not a member of",
        conversationId: (await conversationWithTurn()).conversationId,
        company: kitIdentities.companies.b,
      },
    ];

    const answers: { name: string; status: number; body: unknown }[] = [];
    for (const refused of cases) {
      const events = await h.app.request(eventsPath(refused.conversationId), {
        headers: companyHeaders(refused.company),
      });
      const messages = await h.app.request(
        `${ASSISTANT_KIT_MESSAGES_PATH}?conversationId=${refused.conversationId}`,
        { headers: companyHeaders(refused.company) },
      );

      const body: unknown = await events.json();
      expect({ status: events.status, body }, refused.name).toEqual({
        status: messages.status,
        body: await messages.json(),
      });
      answers.push({ name: refused.name, status: events.status, body });
      expect(
        await subscribers(
          assistantConversationChannel({
            companyId: refused.company,
            conversationId: refused.conversationId,
          }),
        ),
      ).toBe(0);
    }

    // The three conversations a caller could probe are indistinguishable.
    const probes = answers.slice(0, 3);
    for (const probe of probes) {
      expect({ status: probe.status, body: probe.body }, probe.name).toEqual({
        status: 410,
        body: { status: "expired" },
      });
    }
    expect(h.events.streams.open).toBe(0);
    expect(await assistantEventKeys()).toEqual([]);
  });

  it("refuses a request without a session before reading anything", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    h.signOut();

    const response = await h.app.request(eventsPath(conversationId), {
      headers: companyHeaders(),
    });

    expect(response.status).toBe(401);
    expect(await assistantEventKeys()).toEqual([]);
  });

  it("refuses a conversation id that is not a uuid", async () => {
    const h = harness();

    const response = await h.app.request(eventsPath("not-a-uuid"), {
      headers: companyHeaders(),
    });

    expect(response.status).toBe(400);
  });
});

describe("what a stream carries", () => {
  it("starts with a snapshot equal to GET /assistant/kit/messages", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();

    const reader = await openStream(h, conversationId);
    const first = await nextEvent(reader);

    expect(first.type).toBe("snapshot");
    expect(first).toEqual({
      type: "snapshot",
      window: await messagesWindow(h, conversationId),
    });
  });

  it("delivers published events after the snapshot, in publish order", async () => {
    const h = harness();
    const { conversationId, commandId } = await conversationWithTurn();
    const publisher = createRedisAssistantEventPublisher(redis);
    const reader = await openStream(h, conversationId);
    const window = await h.runtime
      .forCaller(anna)
      .kit.messages.read({ conversationId, bind: annaBind });
    const latest = window.messages.at(-1);
    if (latest === undefined) {
      throw new Error("an accepted turn stores messages");
    }

    await publisher.publish(addressOf(conversationId), {
      type: "turn.started",
      conversationId,
      kind: "chat",
      commandId,
    });
    await publisher.publish(addressOf(conversationId), {
      type: "message.updated",
      conversationId,
      message: latest,
    });
    await publisher.publish(addressOf(conversationId), {
      type: "turn.finished",
      kind: "chat",
      commandId,
      status: "done",
      window,
    });

    const received = [
      await nextEvent(reader),
      await nextEvent(reader),
      await nextEvent(reader),
      await nextEvent(reader),
    ];
    expect(received.map((event) => event.type)).toEqual([
      "snapshot",
      "turn.started",
      "message.updated",
      "turn.finished",
    ]);
  });

  it("carries the message's stored revision in message.updated, and in turn.finished a window equal to GET /assistant/kit/messages", async () => {
    const h = harness();
    const { conversationId, commandId, placeholderId } =
      await conversationWithTurn();
    const publisher = createRedisAssistantEventPublisher(redis);
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    await updatePlaceholder(h, conversationId, placeholderId);
    const window = await h.runtime
      .forCaller(anna)
      .kit.messages.read({ conversationId, bind: annaBind });
    const latest = window.messages.at(-1);
    if (latest === undefined) {
      throw new Error("an accepted turn stores messages");
    }
    await publisher.publish(addressOf(conversationId), {
      type: "message.updated",
      conversationId,
      message: latest,
    });
    await publisher.publish(addressOf(conversationId), {
      type: "turn.finished",
      kind: "chat",
      commandId,
      status: "done",
      window,
    });

    const updated = await nextEvent(reader);
    const finished = await nextEvent(reader);
    expect(await storedRevision(placeholderId)).toBe(2);
    expect(updated).toMatchObject({
      type: "message.updated",
      message: { messageId: placeholderId, revision: 2 },
    });
    expect(finished).toEqual({
      type: "turn.finished",
      kind: "chat",
      commandId,
      status: "done",
      window: await messagesWindow(h, conversationId),
    });
  });

  it("sends a heartbeat comment, and keeps the stream's presence alive on it", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    await h.timers.beat();

    expect(await reader.next()).toEqual({ comment: "heartbeat" });
    expect(
      await createRedisAssistantPresence(redis).watchers(
        addressOf(conversationId),
      ),
    ).toBe(1);
    expect(
      await redis.pttl(assistantPresenceKey(addressOf(conversationId))),
    ).toBeGreaterThan(0);
  });

  it("shows the current state on a reconnect after an event it missed", async () => {
    const h = harness();
    const { conversationId, placeholderId } = await conversationWithTurn();
    const first = await openStream(h, conversationId);
    await nextEvent(first);
    await first.cancel();
    await h.events.streams.settled();

    // Published while nobody listened: gone, and nothing replays it.
    await updatePlaceholder(h, conversationId, placeholderId);
    const window = await h.runtime
      .forCaller(anna)
      .kit.messages.read({ conversationId, bind: annaBind });
    const latest = window.messages.at(-1);
    if (latest === undefined) {
      throw new Error("an accepted turn stores messages");
    }
    await createRedisAssistantEventPublisher(redis).publish(
      addressOf(conversationId),
      { type: "message.updated", conversationId, message: latest },
    );

    const again = await openStream(h, conversationId);
    const snapshot = await nextEvent(again);

    expect(snapshot).toEqual({
      type: "snapshot",
      window: await messagesWindow(h, conversationId),
    });
    expect(
      snapshot.type === "snapshot"
        ? snapshot.window.messages.find(
            (message) => message.messageId === placeholderId,
          )?.revision
        : undefined,
    ).toBe(2);
  });

  it("reaches the worker's lowercase channel and presence key when the client sends a mixed-case conversation id", async () => {
    const h = harness();
    const { conversationId, commandId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId.toUpperCase());
    await nextEvent(reader);

    await createRedisAssistantEventPublisher(redis).publish(
      addressOf(conversationId),
      { type: "turn.started", conversationId, kind: "chat", commandId },
    );

    expect(await nextEvent(reader)).toMatchObject({
      type: "turn.started",
      commandId,
    });
    expect(
      await createRedisAssistantPresence(redis).watchers(
        addressOf(conversationId),
      ),
    ).toBe(1);
  });
});

describe("when a stream ends", () => {
  it("leaves no Redis subscription, presence or stream slot behind a subscriber that dropped", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const address = addressOf(conversationId);
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);
    expect(await subscribers(assistantConversationChannel(address))).toBe(1);
    expect(await createRedisAssistantPresence(redis).watchers(address)).toBe(1);

    await reader.cancel();
    await h.events.streams.settled();

    expect(await subscribers(assistantConversationChannel(address))).toBe(0);
    expect(await createRedisAssistantPresence(redis).watchers(address)).toBe(0);
    expect(await redis.exists(assistantStreamSlotsKey(anna.userId))).toBe(0);
    expect(await assistantEventKeys()).toEqual([]);
    expect(h.events.streams.open).toBe(0);
  });

  it("ends the stream on the next heartbeat once the session is signed out", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    h.signOut();
    await h.timers.beat();

    expect(await reader.next()).toBeNull();
    await h.events.streams.settled();
    expect(await assistantEventKeys()).toEqual([]);
  });

  it("puts no presence or slot back when a heartbeat was checking the session as the stream ended", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    const session = h.holdSession();
    const beat = h.timers.beat();
    await session.asked;
    // The heartbeat is waiting on the session; the stream ends meanwhile.
    await reader.cancel();
    session.release();
    await beat;
    await h.events.streams.settled();

    expect(await assistantEventKeys()).toEqual([]);
  });

  it("ends a stream that went idle", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    h.timers.idle();

    expect(await reader.next()).toBeNull();
    await h.events.streams.settled();
    expect(await assistantEventKeys()).toEqual([]);
  });

  it("ends every stream on shutdown", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    await h.events.streams.closeAll();

    expect(await reader.next()).toBeNull();
    expect(h.events.streams.open).toBe(0);
    expect(await assistantEventKeys()).toEqual([]);
  });

  it("ends the stream when the Redis subscriber drops, so the client reconnects from a snapshot instead of past a gap", async () => {
    const h = harness();
    const { conversationId } = await conversationWithTurn();
    const reader = await openStream(h, conversationId);
    await nextEvent(reader);

    await redis.call("CLIENT", "KILL", "TYPE", "pubsub");

    expect(await reader.next()).toBeNull();
    await h.events.streams.settled();
  });
});

describe("limits", () => {
  it("refuses a stream beyond the per-person limit, and a closed stream frees its slot", async () => {
    const h = harness({ streamsPerUser: 1 });
    const { conversationId } = await conversationWithTurn();
    const first = await openStream(h, conversationId);
    await nextEvent(first);

    const refused = await h.app.request(eventsPath(conversationId), {
      headers: companyHeaders(),
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "RATE_LIMITED" } });
    expect(
      await subscribers(
        assistantConversationChannel(addressOf(conversationId)),
      ),
    ).toBe(1);

    await first.cancel();
    await h.events.streams.settled();

    const next = await openStream(h, conversationId);
    expect((await nextEvent(next)).type).toBe("snapshot");
  });

  it("keeps a stalled stream's slot counted: a heartbeat refreshes it while its client reads nothing", async () => {
    const h = harness({ streamsPerUser: 1 });
    const { conversationId, commandId } = await conversationWithTurn();
    // Never read: the client stopped reading.
    const stalled = await h.app.request(eventsPath(conversationId), {
      headers: companyHeaders(),
    });
    expect(stalled.status).toBe(200);
    await h.timers.armed;
    const publisher = createRedisAssistantEventPublisher(redis);
    for (let sent = 0; sent < 3; sent += 1) {
      await publisher.publish(addressOf(conversationId), {
        type: "turn.started",
        conversationId,
        kind: "chat",
        commandId,
      });
    }

    // What 45 s without a refresh would do: the slot's deadline has passed.
    await redis.del(assistantStreamSlotsKey(anna.userId));
    await h.timers.beat();

    expect(await redis.zcard(assistantStreamSlotsKey(anna.userId))).toBe(1);
    const another = await h.app.request(eventsPath(conversationId), {
      headers: companyHeaders(),
    });
    expect(another.status).toBe(429);
  });

  it("opens a stream under a spend ceiling that refuses every turn: a stream is not a turn", async () => {
    const budget: AssistantKitBudget = {
      logger: kit.pipeline.logger,
      // Below one turn's reservation, so the company ceiling refuses every turn.
      // (A ceiling of 0 means none at all.)
      limits: {
        ...DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
        dailyBudgetUsdPerCompany: 0.01,
      },
      rateLimitStore: createInMemoryRateLimitStore(),
      budgetStore: createMemoryAiBudgetStore(),
    };
    const h = harness({ budget });
    const { conversationId } = await conversationWithTurn();

    const turn = await h.app.request(ASSISTANT_KIT_CHAT_PATH, {
      method: "POST",
      headers: { ...companyHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        commandId: randomUUID(),
        conversationId,
        text: "ще одне",
      }),
    });
    expect(turn.status).toBe(429);

    const reader = await openStream(h, conversationId);
    expect((await nextEvent(reader)).type).toBe("snapshot");
  });
});
