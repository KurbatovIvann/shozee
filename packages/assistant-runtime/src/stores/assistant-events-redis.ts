/**
 * Redis behind the assistant's events (ADR-0039, SHO-562): publishing, the
 * subscriber an API process fans out from, presence, and the per-person stream
 * slots.
 *
 * All on the shared, non-persistent Redis. Nothing here is a record: a channel
 * message nobody receives is gone, and that is fine because every stream starts
 * from a snapshot read from Postgres. There is deliberately no replay log.
 *
 * Presence and stream slots are the same structure: a sorted set whose members
 * are stream ids and whose scores are deadlines. The deadline is computed from
 * the Redis server's own clock inside the script, so no host clock is ever
 * compared with another — the API writes presence and the worker reads it.
 */
import { CoreInvariantError } from "@showzy/core/errors";
import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import {
  ASSISTANT_PRESENCE_TTL_MS,
  ASSISTANT_STREAMS_PER_USER,
  assistantConversationChannel,
  assistantPresenceKey,
  assistantStreamSlotsKey,
  decodeAssistantEvent,
  encodeAssistantEvent,
  type AssistantConversationAddress,
} from "../events.js";

/**
 * Add or refresh one member with a deadline of now + ttl, after dropping every
 * member whose deadline has passed. With a limit, a member not already present
 * is refused when the set is full. The key's own expiry follows the newest
 * deadline, so a set whose streams all vanished without leaving goes too.
 */
const LEASE_ENTER_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local limit = tonumber(ARGV[3])
if limit > 0 and not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
local ttl = tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl + 1)
return 1
`;

/** Remove one member; an empty set is removed rather than left behind. */
const LEASE_LEAVE_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end
return 1
`;

/** Members whose deadline has not passed. */
const LEASE_COUNT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local n = redis.call('ZCARD', KEYS[1])
if n == 0 then
  redis.call('DEL', KEYS[1])
end
return n
`;

type LeaseRedis = Pick<Redis, "eval">;

function ttlArgument(ttlMs: number): string {
  return String(Math.max(0, Math.floor(ttlMs)));
}

/**
 * Who is watching a conversation, so a turn that finishes unseen can notify
 * instead (SHO-564). Written by the API's streams, read by whoever sends push.
 */
export interface AssistantPresence {
  /** Record one live stream, or push its deadline out. */
  enter(address: AssistantConversationAddress, streamId: string): Promise<void>;
  leave(address: AssistantConversationAddress, streamId: string): Promise<void>;
  /** How many streams are live on the conversation now. */
  watchers(address: AssistantConversationAddress): Promise<number>;
}

export function createRedisAssistantPresence(
  redis: LeaseRedis,
  options: { readonly ttlMs?: number } = {},
): AssistantPresence {
  const ttl = ttlArgument(options.ttlMs ?? ASSISTANT_PRESENCE_TTL_MS);
  return {
    async enter(address, streamId) {
      await redis.eval(
        LEASE_ENTER_LUA,
        1,
        assistantPresenceKey(address),
        streamId,
        ttl,
        "0",
      );
    },
    async leave(address, streamId) {
      await redis.eval(
        LEASE_LEAVE_LUA,
        1,
        assistantPresenceKey(address),
        streamId,
      );
    },
    async watchers(address) {
      const count = await redis.eval(
        LEASE_COUNT_LUA,
        1,
        assistantPresenceKey(address),
      );
      return typeof count === "number" ? count : 0;
    },
  };
}

/**
 * How many streams one person holds open, across processes. Counted in Redis
 * rather than per process because a person's connections land on whichever API
 * process a balancer picks. A stream is not a turn: nothing here touches the
 * turn budget.
 */
export interface AssistantStreamSlots {
  /** `false` when the person already holds the limit. */
  acquire(userId: string, streamId: string): Promise<boolean>;
  /** Push an open stream's deadline out. Never refused. */
  refresh(userId: string, streamId: string): Promise<void>;
  release(userId: string, streamId: string): Promise<void>;
}

export function createRedisAssistantStreamSlots(
  redis: LeaseRedis,
  options: { readonly limit?: number; readonly ttlMs?: number } = {},
): AssistantStreamSlots {
  const ttl = ttlArgument(options.ttlMs ?? ASSISTANT_PRESENCE_TTL_MS);
  const limit = String(
    Math.max(1, Math.floor(options.limit ?? ASSISTANT_STREAMS_PER_USER)),
  );
  return {
    async acquire(userId, streamId) {
      const taken = await redis.eval(
        LEASE_ENTER_LUA,
        1,
        assistantStreamSlotsKey(userId),
        streamId,
        ttl,
        limit,
      );
      return taken === 1;
    },
    async refresh(userId, streamId) {
      await redis.eval(
        LEASE_ENTER_LUA,
        1,
        assistantStreamSlotsKey(userId),
        streamId,
        ttl,
        "0",
      );
    },
    async release(userId, streamId) {
      await redis.eval(
        LEASE_LEAVE_LUA,
        1,
        assistantStreamSlotsKey(userId),
        streamId,
      );
    },
  };
}

export interface AssistantEventPublisher {
  publish(
    address: AssistantConversationAddress,
    event: AssistantPublishedEvent,
  ): Promise<void>;
}

/**
 * The producer's half. Validates before publishing, so a malformed event fails
 * where it was built.
 */
export function createRedisAssistantEventPublisher(
  redis: Pick<Redis, "publish">,
): AssistantEventPublisher {
  return {
    async publish(address, event) {
      await redis.publish(
        assistantConversationChannel(address),
        encodeAssistantEvent(event),
      );
    },
  };
}

export interface AssistantEventListener {
  /** Called in the order the channel delivered. */
  onEvent(event: AssistantPublishedEvent): void;
  /**
   * The subscriber connection dropped. Events published meanwhile are gone, so
   * a stream must end and let its client reconnect from a snapshot, rather than
   * carry on as if nothing was missed.
   */
  onLost(): void;
}

export interface AssistantEventSubscription {
  close(): Promise<void>;
}

/**
 * One subscriber connection per process, fanned out to that process's streams.
 * A Redis connection in subscribe mode can run nothing else, so it is its own.
 */
export interface AssistantEventHub {
  /** Resolves once Redis has confirmed the channel subscription. */
  subscribe(
    address: AssistantConversationAddress,
    listener: AssistantEventListener,
  ): Promise<AssistantEventSubscription>;
  close(): Promise<void>;
}

interface ChannelEntry {
  readonly listeners: Set<AssistantEventListener>;
  readonly ready: Promise<void>;
}

export function createRedisAssistantEventHub(
  redis: Pick<Redis, "duplicate">,
  options: { readonly logger: Logger },
): AssistantEventHub {
  // No automatic resubscription: a reconnect has already lost events, and a
  // silent resubscribe would let a stream carry on as if it had not.
  const subscriber = redis.duplicate({ autoResubscribe: false });
  const channels = new Map<string, ChannelEntry>();
  let closed = false;

  subscriber.on("message", (channel: string, raw: string) => {
    const entry = channels.get(channel);
    if (entry === undefined) {
      return;
    }
    const event = decodeAssistantEvent(raw);
    if (event === null) {
      options.logger.warn(
        { channel },
        "assistant event could not be read and was dropped",
      );
      return;
    }
    for (const listener of [...entry.listeners]) {
      listener.onEvent(event);
    }
  });

  subscriber.on("close", () => {
    const lost = [...channels.values()].flatMap((entry) => [
      ...entry.listeners,
    ]);
    channels.clear();
    for (const listener of lost) {
      listener.onLost();
    }
  });

  subscriber.on("error", (error: unknown) => {
    options.logger.warn({ err: error }, "assistant event subscriber error");
  });

  async function release(
    channel: string,
    entry: ChannelEntry,
    listener: AssistantEventListener,
  ): Promise<void> {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && channels.get(channel) === entry) {
      channels.delete(channel);
      await subscriber.unsubscribe(channel);
    }
  }

  return {
    async subscribe(address, listener) {
      if (closed) {
        throw new CoreInvariantError("assistant event hub is closed");
      }
      const channel = assistantConversationChannel(address);
      let entry = channels.get(channel);
      if (entry === undefined) {
        const created: ChannelEntry = {
          listeners: new Set(),
          ready: subscriber.subscribe(channel).then(() => undefined),
        };
        channels.set(channel, created);
        entry = created;
      }
      const held = entry;
      held.listeners.add(listener);
      try {
        await held.ready;
      } catch (error) {
        await release(channel, held, listener);
        throw error;
      }
      let open = true;
      return {
        async close() {
          if (!open) {
            return;
          }
          open = false;
          await release(channel, held, listener);
        },
      };
    },
    async close() {
      closed = true;
      channels.clear();
      try {
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    },
  };
}
