/**
 * `GET /assistant/kit/events` — the conversation, live (ADR-0039, SHO-562).
 *
 * Server-sent events, one way: commands stay idempotent POSTs, and this only
 * tells a client what changed. Every connection begins with a `snapshot` of the
 * latest window read from Postgres; after it, the events a running turn
 * publishes on the conversation's Redis channel, in the order they were
 * published. Nothing is replayed. A client that missed an event reconnects and
 * starts from a snapshot again, which is why a lost channel message costs
 * nothing and no log of them is kept.
 *
 * Authorization is the other routes' own: the session, the company header, and
 * a read of the conversation as the caller. The read is the author rule — a
 * conversation that is not this person's and one that does not exist both
 * answer 410, exactly as `GET /assistant/kit/messages` does, and nothing is
 * subscribed before it has succeeded.
 *
 * A stream is not a turn. It is not wrapped in the spend guard and takes
 * nothing from the turn budget; it has its own per-person limit.
 */
import { randomUUID } from "node:crypto";

import {
  ASSISTANT_EVENTS_HEARTBEAT_MS,
  ASSISTANT_STREAM_IDLE_MS,
  ASSISTANT_STREAM_PENDING_WRITES_MAX,
  readAssistantChatWindow,
  type AssistantChatWindowWithTurn,
  type AssistantConversationAddress,
  type AssistantEventHub,
  type AssistantPresence,
  type AssistantStreamSlots,
} from "@showzy/assistant-runtime";
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import {
  json,
  requireCaller,
  type AssistantKitAppEnv,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export const ASSISTANT_KIT_EVENTS_PATH = "/assistant/kit/events";

/**
 * The two clocks a stream runs on. Injected so a test can fire a heartbeat or
 * an idle close when it decides to, not after a real wait.
 */
export interface AssistantKitStreamTimers {
  /** `tick` never rejects; its promise is one whole heartbeat, for a test to await. */
  every(ms: number, tick: () => Promise<void>): () => void;
  after(ms: number, fire: () => void): () => void;
}

export const systemStreamTimers: AssistantKitStreamTimers = {
  every(ms, tick) {
    const handle = setInterval(() => {
      void tick();
    }, ms);
    handle.unref();
    return () => {
      clearInterval(handle);
    };
  },
  after(ms, fire) {
    const handle = setTimeout(fire, ms);
    handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};

interface OpenStream {
  close(): Promise<void>;
}

/**
 * This process's open streams. Shutdown closes them first: the HTTP server
 * waits for its connections, and a stream would otherwise hold it open for good.
 */
export interface AssistantKitStreams {
  readonly open: number;
  closeAll(): Promise<void>;
  /** Resolves once every stream that has ended has also released its Redis state. */
  settled(): Promise<void>;
  /** Resolves once no stream is open and every one has released its Redis state. */
  drained(): Promise<void>;
}

interface AssistantKitStreamRegistry extends AssistantKitStreams {
  add(stream: OpenStream): void;
  remove(stream: OpenStream): void;
  cleaning(done: Promise<void>): void;
}

function createStreamRegistry(): AssistantKitStreamRegistry {
  const live = new Set<OpenStream>();
  const cleanups = new Set<Promise<void>>();
  const waiting: (() => void)[] = [];
  const registry: AssistantKitStreamRegistry = {
    get open() {
      return live.size;
    },
    async closeAll() {
      await Promise.all([...live].map((stream) => stream.close()));
    },
    async settled() {
      await Promise.all([...cleanups]);
    },
    async drained() {
      if (live.size > 0) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }
      await registry.settled();
    },
    add(stream) {
      live.add(stream);
    },
    remove(stream) {
      live.delete(stream);
      if (live.size === 0) {
        for (const resolve of waiting.splice(0)) {
          resolve();
        }
      }
    },
    cleaning(done) {
      cleanups.add(done);
      void done.then(() => {
        cleanups.delete(done);
      });
    },
  };
  return registry;
}

export interface AssistantKitEvents {
  readonly hub: AssistantEventHub;
  readonly presence: AssistantPresence;
  readonly slots: AssistantStreamSlots;
  readonly streams: AssistantKitStreams;
  readonly timers: AssistantKitStreamTimers;
  readonly heartbeatMs: number;
  readonly idleMs: number;
  /** Frames a stream may hold unwritten before it is ended. */
  readonly pendingWritesMax: number;
  readonly streamId: () => string;
}

interface AssistantKitEventsInternal extends AssistantKitEvents {
  readonly streams: AssistantKitStreamRegistry;
}

export function createAssistantKitEvents(deps: {
  readonly hub: AssistantEventHub;
  readonly presence: AssistantPresence;
  readonly slots: AssistantStreamSlots;
  readonly timers?: AssistantKitStreamTimers;
  readonly heartbeatMs?: number;
  readonly idleMs?: number;
  readonly pendingWritesMax?: number;
  readonly streamId?: () => string;
}): AssistantKitEvents {
  const events: AssistantKitEventsInternal = {
    hub: deps.hub,
    presence: deps.presence,
    slots: deps.slots,
    streams: createStreamRegistry(),
    timers: deps.timers ?? systemStreamTimers,
    heartbeatMs: deps.heartbeatMs ?? ASSISTANT_EVENTS_HEARTBEAT_MS,
    idleMs: deps.idleMs ?? ASSISTANT_STREAM_IDLE_MS,
    pendingWritesMax:
      deps.pendingWritesMax ?? ASSISTANT_STREAM_PENDING_WRITES_MAX,
    streamId: deps.streamId ?? (() => randomUUID()),
  };
  return events;
}

function registryOf(events: AssistantKitEvents): AssistantKitStreamRegistry {
  // Only `createAssistantKitEvents` builds this value, and it always builds a
  // full registry; the narrower public type keeps its bookkeeping private.
  return events.streams as AssistantKitStreamRegistry;
}

/** A comment line: keeps intermediaries from timing the connection out. */
const HEARTBEAT_COMMENT = ": heartbeat\n\n";

const FELL_BEHIND =
  "assistant event stream fell behind its client and was closed";

export async function handleAssistantKitEvents(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
  events: AssistantKitEvents,
): Promise<Response> {
  const requestId = c.get("requestId");
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }
  const conversationId = z
    .uuid()
    .safeParse(c.req.query("conversationId") ?? "");
  if (!conversationId.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }

  const assistantCaller = {
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  };
  const { kit, turns } = runtime.forCaller(assistantCaller);
  const scope = { conversationId: conversationId.data, bind: caller.bind };

  // The author rule, and the same answer as the messages route: a foreign or
  // missing conversation throws here and the app's error handler answers 410.
  // Nothing has been subscribed or counted yet, so a refusal leaves nothing.
  await kit.messages.read(scope);

  // A channel is a tenant boundary, so it is named from the company the staff
  // context verified — not from the header. Today the two are the same string;
  // only one of them is authority, and it stays right if selectors change.
  const address: AssistantConversationAddress = {
    companyId: await runtime.staffCompany(assistantCaller),
    conversationId: conversationId.data,
  };
  const streamId = events.streamId();
  const streams = registryOf(events);
  const log = runtime.logger.child({
    request_id: requestId,
    stream_id: streamId,
  });

  if (!(await events.slots.acquire(caller.userId, streamId))) {
    return json(429, { error: { code: "RATE_LIMITED" } }, requestId);
  }

  // Events that arrive before the snapshot is written wait here, then follow
  // it — up to the same cap as a stream's unwritten frames.
  const pending: AssistantPublishedEvent[] = [];
  let deliver: ((event: AssistantPublishedEvent) => void) | null = null;
  // The stream must end before it has started: the subscriber connection
  // dropped, or events piled up past the cap while the snapshot was read.
  let stopRequested = false;
  let stop: (() => void) | null = null;
  const requestStop = (): void => {
    stopRequested = true;
    stop?.();
  };

  let subscription;
  try {
    subscription = await events.hub.subscribe(address, {
      onEvent: (event) => {
        if (deliver !== null) {
          deliver(event);
          return;
        }
        if (stopRequested) {
          return;
        }
        pending.push(event);
        if (pending.length > events.pendingWritesMax) {
          log.info({ pending_writes: pending.length }, FELL_BEHIND);
          pending.length = 0;
          requestStop();
        }
      },
      onLost: requestStop,
    });
  } catch (error) {
    await events.slots.release(caller.userId, streamId);
    throw error;
  }

  // Subscribed before reading, so nothing published between the read and the
  // subscription is missed. An event the snapshot already reflects can then
  // arrive after it. For `message.updated` that is harmless: a client keeps the
  // higher revision. For `turn.finished` it is not entirely: its window's
  // `openPause` carries no revision, so a finish held here can reach the client
  // after a newer snapshot and show a question that closed in between (an
  // abandon from another device publishes nothing). Answering it is refused as
  // `stale`, so the harm is one refused tap; how a client merges a window that
  // arrives after a newer one is SHO-563's rule, not this route's.
  let snapshot: AssistantChatWindowWithTurn;
  try {
    snapshot = await readAssistantChatWindow(kit, turns, scope);
  } catch (error) {
    await subscription.close();
    await events.slots.release(caller.userId, streamId);
    throw error;
  }

  const held = subscription;
  const headers = c.req.raw.headers;
  const signal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    let closed = false;
    let finish = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let markCleaned = (): void => undefined;
    const cleaned = new Promise<void>((resolve) => {
      markCleaned = resolve;
    });
    let cancelHeartbeat = (): void => undefined;
    let cancelIdle = (): void => undefined;

    const end = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      cancelHeartbeat();
      cancelIdle();
      streams.cleaning(cleaned);
      finish();
    };
    const handle: OpenStream = {
      close: async () => {
        end();
        await cleaned;
      },
    };
    // Read through a call: `end` runs from callbacks (an abort, a lost
    // subscriber, a failed check), so the flag can change between any two
    // awaits here.
    const isClosed = (): boolean => closed;

    // One write at a time, in the order they were asked for: that is what keeps
    // the snapshot first and the events in publish order. Only writes wait here —
    // a client that stops reading stalls this queue and nothing else.
    let backlog = 0;
    let writes: Promise<void> = Promise.resolve();
    const enqueue = (write: () => Promise<void>): void => {
      if (closed) {
        return;
      }
      backlog += 1;
      if (backlog > events.pendingWritesMax) {
        // The client stopped reading. Every frame waiting for it stays in
        // memory until it does; ending the stream lets all of it go, and the
        // client's next connection starts from a snapshot.
        log.info({ pending_writes: backlog }, FELL_BEHIND);
        end();
        return;
      }
      writes = writes
        .then(async () => {
          if (!closed) {
            await write();
          }
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, "assistant event stream failed");
          end();
        })
        .then(() => {
          backlog -= 1;
        });
    };
    const restartIdle = (): void => {
      cancelIdle();
      if (!closed) {
        cancelIdle = events.timers.after(events.idleMs, end);
      }
    };
    const sendEvent = (event: AssistantPublishedEvent): void => {
      enqueue(async () => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
        // Idle counts from what reached the client, not from what arrived for
        // it: traffic a client never reads must not keep its stream open.
        restartIdle();
      });
    };

    // Re-checked on every beat: a session signed out or revoked elsewhere ends
    // the stream within one heartbeat. Neither refreshed nor read from the
    // cookie cache, so watching does not keep a session alive and a revoked one
    // is seen at once. None of it waits behind the write queue: a stalled
    // client must not be able to let its slot lapse while its stream is open.
    let beating: Promise<void> | null = null;
    const inFlightBeat = (): Promise<void> | null => beating;
    const beat = async (): Promise<void> => {
      try {
        const session = await runtime.auth.api.getSession({
          headers,
          query: { disableRefresh: true, disableCookieCache: true },
        });
        if (session === null || session.user.id !== caller.userId) {
          end();
          return;
        }
        if (isClosed()) {
          return;
        }
        await events.presence.enter(address, streamId);
        await events.slots.refresh(caller.userId, streamId);
        enqueue(async () => {
          await stream.write(HEARTBEAT_COMMENT);
        });
      } catch (error) {
        log.warn({ err: error }, "assistant event stream heartbeat failed");
        end();
      }
    };
    const heartbeat = (): Promise<void> => {
      // One check at a time: a slow session store must not stack them up.
      const running = inFlightBeat();
      if (running !== null) {
        return running;
      }
      const started = beat().finally(() => {
        beating = null;
      });
      beating = started;
      return started;
    };

    streams.add(handle);
    stream.onAbort(end);
    if (signal.aborted) {
      end();
    } else {
      signal.addEventListener("abort", end, { once: true });
    }
    stop = end;
    if (stopRequested) {
      end();
    }

    try {
      if (!isClosed()) {
        await events.presence.enter(address, streamId);
      }
      enqueue(() =>
        stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ type: "snapshot", window: snapshot }),
        }),
      );
      deliver = sendEvent;
      for (const event of pending.splice(0)) {
        sendEvent(event);
      }
      restartIdle();

      if (!isClosed()) {
        cancelHeartbeat = events.timers.every(events.heartbeatMs, heartbeat);
      }

      await ended;
    } catch (error) {
      // Never rethrown: Hono would write the message into the stream.
      log.warn({ err: error }, "assistant event stream failed");
      end();
    } finally {
      // Abort first: it drops whatever a client never read and makes any write
      // still pending fail at once, so waiting for the queue cannot hang on a
      // client that stopped reading.
      stream.abort();
      await writes;
      // A heartbeat already checking the session finishes before anything is
      // released, so it cannot put back what the lines below remove. Its awaits
      // are the session store and Redis, never the client's socket.
      await (inFlightBeat() ?? Promise.resolve());
      deliver = null;
      await release(log, "subscription", () => held.close());
      await release(log, "presence", () =>
        events.presence.leave(address, streamId),
      );
      await release(log, "stream slot", () =>
        events.slots.release(caller.userId, streamId),
      );
      streams.remove(handle);
      markCleaned();
    }
  });
}

async function release(
  log: AssistantKitRuntime["logger"],
  what: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    // The Redis side expires on its own — presence and slots by deadline, a
    // subscription with the connection — so a failed release is logged, not
    // retried.
    log.warn(
      { err: error, released: what },
      "assistant event stream release failed",
    );
  }
}
