/**
 * Redis behind the `assistant-kit` pause port, and the command receipts beside
 * it.
 *
 * Only short-lived, atomic things. An open question has a deadline measured in
 * minutes and exactly one atomic claim; a command receipt is the same `SET NX`
 * used to answer "has this attempt already run?". The document and the history
 * are the product's record and live in Postgres.
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

/**
 * `DEL key` only if it still holds what we put there.
 *
 * The releasing half of a lease. A plain `DEL` would let a holder whose ttl had
 * already run out remove the lock a later turn has since taken.
 */
const DELETE_IF_EQUALS_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
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
    async deleteIfEquals(key, expected) {
      const result = await redis.eval(
        DELETE_IF_EQUALS_LUA,
        1,
        assistantKitPauseKey(key),
        expected,
      );
      return result === 1;
    },
    async delete(key) {
      await redis.del(assistantKitPauseKey(key));
    },
  };
}

export const ASSISTANT_KIT_COMMAND_PREFIX = `${ASSISTANT_KIT_KEY_PREFIX}cmd:`;

/**
 * How long a command stays spoken for.
 *
 * Long enough to cover a person picking the phone back up after a dropped
 * connection and pressing send again; short enough that a `commandId` burned by
 * a crash in the microsecond before any work began heals on its own. Retries
 * that matter happen in seconds, not minutes — this is generous on purpose,
 * because the cost of being too short is a duplicate order and the cost of
 * being too long is one sentence that has to be retyped.
 */
export const ASSISTANT_KIT_COMMAND_TTL_MS = 15 * 60 * 1000;

/**
 * One attempt, once.
 *
 * The receipt stores no response body. It does not need one: every route
 * already answers with the conversation as it stands, so replaying a command means reading
 * where the conversation actually is — which is more truthful than a recording
 * of what the first attempt said, because the conversation may have moved since.
 */
export interface AssistantKitCommands {
  /**
   * `false` when this command has already been taken. The caller must then do
   * nothing and answer with the current document.
   */
  take(command: AssistantKitCommandRef): Promise<boolean>;
  /** Give it back, for a request that took it and then did nothing at all. */
  release(command: AssistantKitCommandRef): Promise<void>;
}

export interface AssistantKitCommandRef {
  readonly bind: string;
  readonly conversationId: string;
  readonly commandId: string;
  /**
   * Which request this token was spent on.
   *
   * A send and an answer are different attempts even when a client happens to
   * label them with the same token. Without this, a client that reused one id
   * across the two would have its answer replayed as if it were the send — a
   * tap that does nothing, silently, for the receipt's whole lifetime.
   */
  readonly route: "chat" | "answer";
}

export function assistantKitCommandKey(
  command: AssistantKitCommandRef,
): string {
  // `bind` first: a receipt belongs to one person in one company, so a guessed
  // conversation id from elsewhere cannot collide with theirs.
  return `${ASSISTANT_KIT_COMMAND_PREFIX}${command.route}:${command.bind}:${command.conversationId}:${command.commandId}`;
}

export function createRedisAssistantKitCommands(
  redis: RedisLike,
  ttlMs = ASSISTANT_KIT_COMMAND_TTL_MS,
): AssistantKitCommands {
  return {
    async take(command) {
      const result = await redis.eval(
        SET_IF_ABSENT_LUA,
        1,
        assistantKitCommandKey(command),
        "1",
        String(Math.max(1, Math.floor(ttlMs))),
      );
      return redisSetNxSucceeded(result);
    },
    async release(command) {
      await redis.del(assistantKitCommandKey(command));
    },
  };
}

/**
 * Receipts that live in this process only.
 *
 * Correct for a single-process run, and what the route tests use. It is a Map
 * because that is all a receipt is: `SET NX` and a delete, with an expiry this
 * one does not need — nothing in a test or a single run outlives the process.
 */
export function memoryAssistantKitCommands(): AssistantKitCommands & {
  readonly taken: Set<string>;
} {
  const taken = new Set<string>();
  return {
    taken,
    take(command) {
      const key = assistantKitCommandKey(command);
      if (taken.has(key)) {
        return Promise.resolve(false);
      }
      taken.add(key);
      return Promise.resolve(true);
    },
    release(command) {
      taken.delete(assistantKitCommandKey(command));
      return Promise.resolve();
    },
  };
}
