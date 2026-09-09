/**
 * Redis behind the `assistant-kit` ports.
 *
 * The package asks for three tiny things — a compare-and-set key store, a
 * document blob, and model history — and has no opinion about where they live.
 * These are the implementations for the dark path.
 *
 * Keys are namespaced under `kit:` so nothing here can collide with the pending
 * store the live assistant still uses. The two runtimes share a Redis and must
 * not share a key.
 *
 * The history store is deliberately the weakest part: model history in Redis is
 * transient, and a conversation that outlives the ttl starts over. That is
 * acceptable while the point is to exercise the protocol by hand; it is not
 * acceptable for a durable assistant, and swapping it is one port.
 */
import type {
  DocumentStore,
  ModelMessage,
  PauseScope,
  PauseStore,
} from "@showzy/assistant-kit";
import type { Redis } from "ioredis";

import { redisSetNxSucceeded } from "./redis.js";

/** `SET key value PX ttl NX` — the one-open-pause guard. */
const SET_IF_ABSENT_LUA = `
return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
`;

/**
 * Compare-and-set, keeping the existing expiry.
 *
 * This is the single atomic point of the whole claim protocol: whoever wins it
 * owns the answer. Renewing the ttl here would let a pause outlive its own
 * deadline every time it is touched.
 */
const COMPARE_AND_SET_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0
`;

export const ASSISTANT_KIT_KEY_PREFIX = "kit:";

export function assistantKitPauseKey(key: string): string {
  return `${ASSISTANT_KIT_KEY_PREFIX}${key}`;
}

export function assistantKitDocumentKey(conversationId: string): string {
  return `${ASSISTANT_KIT_KEY_PREFIX}doc:${conversationId}`;
}

export function assistantKitHistoryKey(scope: PauseScope): string {
  return `${ASSISTANT_KIT_KEY_PREFIX}history:${scope.bind}:${scope.conversationId}`;
}

type RedisLike = Pick<Redis, "eval" | "get" | "set" | "del">;

export function createRedisAssistantKitPauseStore(
  redis: RedisLike,
): PauseStore {
  return {
    async get(key) {
      const raw = await redis.get(assistantKitPauseKey(key));
      return typeof raw === "string" && raw !== "" ? raw : null;
    },
    async setIfAbsent(key, value, ttlMs) {
      const result = await redis.eval(
        SET_IF_ABSENT_LUA,
        1,
        assistantKitPauseKey(key),
        value,
        String(Math.max(1, Math.floor(ttlMs))),
      );
      return redisSetNxSucceeded(result);
    },
    async compareAndSet(key, expected, next) {
      const result = await redis.eval(
        COMPARE_AND_SET_LUA,
        1,
        assistantKitPauseKey(key),
        expected,
        next,
      );
      return result === 1;
    },
    async delete(key) {
      await redis.del(assistantKitPauseKey(key));
    },
  };
}

export interface AssistantKitBlobOptions {
  /** How long a conversation's stored bytes survive without being touched. */
  readonly ttlMs: number;
}

export const ASSISTANT_KIT_DEFAULT_BLOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseBlob(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Unreadable bytes are treated as absent. The package validates what it
    // gets back anyway, and a half-written blob must not stop a conversation.
    return null;
  }
}

export function createRedisAssistantKitDocumentStore(
  redis: RedisLike,
  options: AssistantKitBlobOptions = {
    ttlMs: ASSISTANT_KIT_DEFAULT_BLOB_TTL_MS,
  },
): DocumentStore {
  return {
    async read(conversationId) {
      return parseBlob(await redis.get(assistantKitDocumentKey(conversationId)));
    },
    async write(conversationId, document) {
      await redis.set(
        assistantKitDocumentKey(conversationId),
        JSON.stringify(document),
        "PX",
        Math.max(1, Math.floor(options.ttlMs)),
      );
    },
  };
}

export interface AssistantKitHistoryStore {
  load(scope: PauseScope): Promise<ModelMessage[]>;
  save(scope: PauseScope, messages: readonly ModelMessage[]): Promise<void>;
}

export function createRedisAssistantKitHistoryStore(
  redis: RedisLike,
  options: AssistantKitBlobOptions = {
    ttlMs: ASSISTANT_KIT_DEFAULT_BLOB_TTL_MS,
  },
): AssistantKitHistoryStore {
  return {
    async load(scope) {
      const parsed = parseBlob(await redis.get(assistantKitHistoryKey(scope)));
      return Array.isArray(parsed) ? (parsed as ModelMessage[]) : [];
    },
    async save(scope, messages) {
      await redis.set(
        assistantKitHistoryKey(scope),
        JSON.stringify(messages),
        "PX",
        Math.max(1, Math.floor(options.ttlMs)),
      );
    },
  };
}
