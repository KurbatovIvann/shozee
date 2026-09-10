/**
 * Redis behind the `assistant-kit` pause port.
 *
 * Only the pause. An open question has a deadline measured in minutes and
 * exactly one atomic claim, which is what this store is for; the document and
 * the history are the product's record and live in Postgres.
 *
 * Keys are namespaced under `kit:` so nothing here can collide with the pending
 * store the previous assistant still uses. The two share a Redis and must not
 * share a key.
 */
import type { PauseStore } from "@showzy/assistant-kit";
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
