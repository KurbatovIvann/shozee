/**
 * `GET /assistant/kit/events` with in-memory ports (SHO-562).
 *
 * The database suite proves the route against Postgres and Redis. This one
 * proves what only a controlled port shows deterministically: a client that
 * never reads while events keep arriving, the exact arguments of the session
 * re-check, which company names the channel, and the policy values the route
 * runs with when nothing overrides them.
 *
 * A response body nobody reads is a client that stopped reading: the stream
 * writes the first frame into its buffer and every later write waits.
 */
import { createAssistantKit } from "@showzy/assistant-kit";
import { stubTextModel, testDeps } from "@showzy/assistant-kit/testing";
import {
  ASSISTANT_EVENTS_HEARTBEAT_MS,
  ASSISTANT_STREAM_IDLE_MS,
  ASSISTANT_STREAM_PENDING_WRITES_MAX,
  assistantConversationChannel,
  assistantInteractions,
  memoryAssistantKitCommands,
  memoryAssistantTurnStore,
  type AssistantConversationAddress,
  type AssistantEventHub,
  type AssistantEventListener,
  type AssistantPresence,
  type AssistantStreamSlots,
  type ResolveAnswer,
} from "@showzy/assistant-runtime";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASSISTANT_KIT_EVENTS_PATH,
  createAssistantKitApp,
} from "./assistant-kit.js";
import {
  createAssistantKitEvents,
  type AssistantKitEvents,
  type AssistantKitStreamTimers,
} from "./assistant-kit-events.js";

const USER = "user-1";
const COMPANY = "11111111-1111-4111-8111-1111111111aa";
/** What the staff context verified: deliberately not the header's value. */
const VERIFIED_COMPANY = "22222222-2222-4222-8222-2222222222bb";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";

const verifiedAddress: AssistantConversationAddress = {
  companyId: VERIFIED_COMPANY,
  conversationId: CONVERSATION,
};

const started: AssistantPublishedEvent = {
  type: "turn.started",
  conversationId: CONVERSATION,
  kind: "chat",
  commandId: COMMAND,
};

function memoryHub() {
  const channels = new Map<string, Set<AssistantEventListener>>();
  const hub: AssistantEventHub = {
    subscribe(address, listener) {
      const channel = assistantConversationChannel(address);
      const listeners = channels.get(channel) ?? new Set();
      listeners.add(listener);
      channels.set(channel, listeners);
      return Promise.resolve({
        close() {
          listeners.delete(listener);
          if (listeners.size === 0) {
            channels.delete(channel);
          }
          return Promise.resolve();
        },
      });
    },
    close: () => Promise.resolve(),
  };
  return {
    hub,
    /** Delivers synchronously, the way a burst of channel messages lands. */
    publish(event: AssistantPublishedEvent, times = 1): void {
      const listeners =
        channels.get(assistantConversationChannel(verifiedAddress)) ?? [];
      for (let sent = 0; sent < times; sent += 1) {
        for (const listener of [...listeners]) {
          listener.onEvent(event);
        }
      }
    },
    channels(): string[] {
      return [...channels.keys()];
    },
  };
}

function memoryPresence() {
  const live = new Set<string>();
  const addresses: AssistantConversationAddress[] = [];
  const presence: AssistantPresence = {
    enter(address, streamId) {
      live.add(streamId);
      addresses.push(address);
      return Promise.resolve();
    },
    leave(_address, streamId) {
      live.delete(streamId);
      return Promise.resolve();
    },
    watchers: () => Promise.resolve(live.size),
  };
  return { presence, live, addresses };
}

/** One person's slots: this suite has only one person, so the id is not kept. */
function memorySlots(limit: number) {
  const held = new Set<string>();
  const refreshed: string[] = [];
  const slots: AssistantStreamSlots = {
    acquire(_userId, streamId) {
      if (held.size >= limit) {
        return Promise.resolve(false);
      }
      held.add(streamId);
      return Promise.resolve(true);
    },
    refresh(_userId, streamId) {
      held.add(streamId);
      refreshed.push(streamId);
      return Promise.resolve();
    },
    release(_userId, streamId) {
      held.delete(streamId);
      return Promise.resolve();
    },
  };
  return { slots, held, refreshed };
}

interface RecordingTimers extends AssistantKitStreamTimers {
  readonly everyMs: number[];
  readonly afterMs: number[];
  /** Resolves once a stream has armed its heartbeat: it has fully started. */
  readonly armed: Promise<void>;
  beat(): Promise<void>;
}

function recordingTimers(): RecordingTimers {
  const beats = new Set<() => Promise<void>>();
  const everyMs: number[] = [];
  const afterMs: number[] = [];
  let arm = (): void => undefined;
  const armed = new Promise<void>((resolve) => {
    arm = resolve;
  });
  return {
    everyMs,
    afterMs,
    armed,
    every(ms, tick) {
      everyMs.push(ms);
      beats.add(tick);
      arm();
      return () => {
        beats.delete(tick);
      };
    },
    after(ms) {
      afterMs.push(ms);
      return () => undefined;
    },
    async beat() {
      await Promise.all([...beats].map((tick) => tick()));
    },
  };
}

type SessionQuery =
  { disableRefresh?: boolean; disableCookieCache?: boolean } | undefined;

const UNUSED_RESOLVE: ResolveAnswer = () =>
  Promise.resolve({
    kind: "error",
    code: "UNUSED",
    message: "no answers in this suite",
  });

const opened: AssistantKitEvents[] = [];

afterEach(async () => {
  for (const events of opened.splice(0)) {
    await events.streams.closeAll();
  }
});

function harness(options?: {
  readonly pendingWritesMax?: number;
  readonly holdPresence?: Promise<void>;
}) {
  const kit = createAssistantKit(testDeps(assistantInteractions));
  const hub = memoryHub();
  const presence = memoryPresence();
  const slots = memorySlots(5);
  const timers = recordingTimers();
  const sessionQueries: SessionQuery[] = [];
  let session: { user: { id: string }; session: { id: string } } | null = {
    user: { id: USER },
    session: { id: "session-1" },
  };

  const presencePort: AssistantPresence =
    options?.holdPresence === undefined
      ? presence.presence
      : {
          ...presence.presence,
          enter: async (address, streamId) => {
            await options.holdPresence;
            await presence.presence.enter(address, streamId);
          },
        };

  const events = createAssistantKitEvents({
    hub: hub.hub,
    presence: presencePort,
    slots: slots.slots,
    timers,
    ...(options?.pendingWritesMax === undefined
      ? {}
      : { pendingWritesMax: options.pendingWritesMax }),
  });
  opened.push(events);

  const app = createAssistantKitApp(
    {
      logger: pino({ level: "silent" }),
      commands: memoryAssistantKitCommands(),
      auth: {
        api: {
          getSession: (args) => {
            sessionQueries.push(args.query);
            return Promise.resolve(session);
          },
        },
      },
      forCaller: () => {
        const history = {
          load: () => Promise.resolve([]),
          save: () => Promise.resolve(),
        };
        return {
          kit,
          history,
          turns: memoryAssistantTurnStore(kit.messages, history),
        };
      },
      staffCompany: () => Promise.resolve(VERIFIED_COMPANY),
      model: stubTextModel("Готово."),
      tools: () => Promise.resolve({}),
      resolveAnswer: UNUSED_RESOLVE,
      prompt: () => ({ system: "you are a test" }),
    },
    undefined,
    events,
  );

  return {
    app,
    events,
    timers,
    hub,
    presence,
    slots,
    sessionQueries,
    signOut() {
      session = null;
    },
  };
}

type Harness = ReturnType<typeof harness>;

function request(h: Harness): Promise<Response> {
  return Promise.resolve(
    h.app.request(
      `${ASSISTANT_KIT_EVENTS_PATH}?conversationId=${CONVERSATION}`,
      {
        headers: { [COMPANY_SELECTOR_HEADER]: COMPANY },
      },
    ),
  );
}

/** A stream that has fully started, whose client never reads a byte. */
async function openUnread(h: Harness): Promise<Response> {
  const response = await request(h);
  expect(response.status).toBe(200);
  await h.timers.armed;
  return response;
}

describe("the stream's policy defaults", () => {
  it("beats every 15 s and closes after 10 idle minutes when nothing overrides them", async () => {
    const h = harness();

    await openUnread(h);

    expect(h.timers.everyMs).toEqual([15_000]);
    expect(ASSISTANT_EVENTS_HEARTBEAT_MS).toBe(15_000);
    expect(h.timers.afterMs[0]).toBe(600_000);
    expect(ASSISTANT_STREAM_IDLE_MS).toBe(600_000);
  });

  it("holds a stream that falls one frame short of the default cap, and ends one that falls further behind", async () => {
    const h = harness();
    await openUnread(h);

    // At most one frame reaches the unread buffer, so these stay within the cap.
    h.hub.publish(started, ASSISTANT_STREAM_PENDING_WRITES_MAX - 1);
    expect(h.events.streams.open).toBe(1);

    h.hub.publish(started, 3);
    await h.events.streams.drained();

    expect(h.slots.held.size).toBe(0);
    expect(h.presence.live.size).toBe(0);
    expect(h.hub.channels()).toEqual([]);
  });
});

describe("the stream's company", () => {
  it("names the channel and presence from the company the staff context verified, not from the header", async () => {
    const h = harness();

    await openUnread(h);

    expect(h.hub.channels()).toEqual([
      assistantConversationChannel(verifiedAddress),
    ]);
    expect(h.presence.addresses).toEqual([verifiedAddress]);
  });
});

describe("the heartbeat", () => {
  it("re-checks the session on a beat without refreshing it or reading the cookie cache, and asks nothing of the kind on connect", async () => {
    const h = harness();
    await openUnread(h);
    expect(h.sessionQueries).toEqual([undefined]);

    await h.timers.beat();

    expect(h.sessionQueries).toEqual([
      undefined,
      { disableRefresh: true, disableCookieCache: true },
    ]);
  });

  it("keeps a stalled stream's slot and presence refreshed: the check does not wait behind writes its client never reads", async () => {
    const h = harness();
    await openUnread(h);
    h.hub.publish(started, 3);

    await h.timers.beat();

    expect(h.slots.refreshed).toHaveLength(1);
    expect(h.slots.held.size).toBe(1);
    expect(h.presence.addresses).toHaveLength(2);
    expect(h.events.streams.open).toBe(1);
  });

  it("ends a stalled stream once its session is signed out, and releases what it held", async () => {
    const h = harness();
    await openUnread(h);
    h.hub.publish(started, 3);

    h.signOut();
    await h.timers.beat();
    await h.events.streams.drained();

    expect(h.slots.held.size).toBe(0);
    expect(h.presence.live.size).toBe(0);
    expect(h.hub.channels()).toEqual([]);
  });
});

describe("a client that stops reading", () => {
  it("is let go past the cap, releasing its subscription, presence and slot", async () => {
    const h = harness({ pendingWritesMax: 4 });
    await openUnread(h);

    h.hub.publish(started, 3);
    expect(h.events.streams.open).toBe(1);

    h.hub.publish(started, 3);
    await h.events.streams.drained();

    expect(h.slots.held.size).toBe(0);
    expect(h.presence.live.size).toBe(0);
    expect(h.hub.channels()).toEqual([]);
  });

  it("counts events that pile up before the snapshot is written against the same cap", async () => {
    let releasePresence = (): void => undefined;
    const holdPresence = new Promise<void>((resolve) => {
      releasePresence = resolve;
    });
    const h = harness({ pendingWritesMax: 4, holdPresence });
    const response = await request(h);
    expect(response.status).toBe(200);

    // The stream has not started: its first presence write is still waiting.
    h.hub.publish(started, 6);
    releasePresence();
    await h.events.streams.drained();

    expect(h.slots.held.size).toBe(0);
    expect(h.hub.channels()).toEqual([]);
    expect(h.timers.everyMs).toEqual([]);
  });
});
