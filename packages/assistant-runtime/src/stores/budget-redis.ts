/**
 * The staff-assistant budget counters on Redis (SHO-505). Here rather than in
 * `apps/api` since SHO-561: a turn's hold is released by the worker too, and it
 * must move the same counters the accept reserved on.
 *
 * It matches `createMemoryAiBudgetStore`, the reference store: `tryAdd` is an
 * increment-with-cap, `add` never leaves a counter below zero and says so when
 * it had to stop there. All are Lua so each read-then-write is atomic, and the counters
 * store a plain decimal string an operator can GET, SET or DEL.
 */
import { CoreInvariantError } from "@showzy/core/errors";
import type { Redis } from "ioredis";

import {
  logAiBudgetFloored,
  parseAiBudgetSpent,
  type AiBudgetStore,
  type AiBudgetStoreLogger,
  type AiBudgetTryAddDecision,
} from "./budget.js";

/** Atomic increment-with-cap for a Kyiv-day USD reservation. */
const AI_BUDGET_TRY_ADD_LUA = `
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttlSec = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil or current ~= current or current < 0 then
  current = 0
end
local nxt = current + amount
if nxt > cap then
  return {0, tostring(current)}
end
local updated = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ttlSec)
return {1, tostring(updated)}
`;

/**
 * Adds a signed amount and floors the counter at zero (SHO-561).
 *
 * A release subtracts what a turn reserved. When the counter no longer holds
 * that much — its key expired with the Kyiv day, an operator reset it, or a
 * hold was released twice — a plain `INCRBYFLOAT` would leave it negative, and
 * a negative counter lifts the day's cap by that amount. At zero or below the
 * key is deleted, as the memory store deletes it; a missing key reads as zero.
 *
 * Returns `{ stored, floored, current }`: `floored` is 1 when a non-zero
 * counter would have gone below zero, the case worth an operator's attention.
 */
const AI_BUDGET_ADD_LUA = `
local amount = tonumber(ARGV[1])
local ttlSec = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1]))
if current == nil or current ~= current or current < 0 then
  current = 0
end
local nxt = current + amount
if nxt ~= nxt or nxt <= 0 then
  redis.call('DEL', KEYS[1])
  local floored = 0
  if nxt < 0 and current > 0 then
    floored = 1
  end
  return {'0', floored, tostring(current)}
end
local stored = string.format('%.17g', nxt)
redis.call('SET', KEYS[1], stored, 'EX', ttlSec)
return {stored, 0, tostring(current)}
`;

/**
 * Records one turn's reservation if none is recorded yet, and reports the hold
 * that stands either way (SHO-572).
 *
 * One script rather than `SET NX` and then a `GET`: a plain `SET NX` says only
 * that it lost, not what the winner recorded, and reading it afterwards is a
 * second round trip that another retry of the same command can interleave with.
 * Here the answer is always the hold actually stored under the key.
 */
const AI_BUDGET_CLAIM_HOLD_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {0, existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
return {1, ARGV[1]}
`;

/**
 * Forgets a recorded hold, and says whether this call is the one that did it.
 *
 * `DEL` returns how many keys it removed, so the caller that gets 1 is the only
 * one that may subtract the hold from the counters. That is what makes a
 * release by the request and a release by the turn row's finisher add up to one
 * subtraction rather than two.
 */
const AI_BUDGET_DROP_HOLD_LUA = `
return redis.call('DEL', KEYS[1])
`;

export function createRedisAiBudgetStore(
  redis: Pick<Redis, "get" | "eval">,
  options?: {
    /** Told when a release had to stop a non-zero counter at zero. */
    readonly logger?: AiBudgetStoreLogger;
  },
): AiBudgetStore {
  return {
    async read(key) {
      return parseAiBudgetSpent(await redis.get(key));
    },
    async add(key, amountUsd, ttlSec) {
      const result = await redis.eval(
        AI_BUDGET_ADD_LUA,
        1,
        key,
        String(amountUsd),
        String(ttlSec),
      );
      if (!Array.isArray(result) || result.length < 3) {
        throw new CoreInvariantError(
          "ai-budget add Redis script returned an unexpected value",
        );
      }
      if (Number(result[1]) === 1) {
        logAiBudgetFloored(options?.logger, {
          key,
          currentUsd: parseAiBudgetSpent(scriptSpentRaw(result[2])),
          deltaUsd: amountUsd,
        });
      }
      return parseAiBudgetSpent(scriptSpentRaw(result[0]));
    },
    async tryAdd(key, amountUsd, capUsd, ttlSec) {
      const result = await redis.eval(
        AI_BUDGET_TRY_ADD_LUA,
        1,
        key,
        String(amountUsd),
        String(capUsd),
        String(ttlSec),
      );
      return parseTryAddResult(result);
    },
    async claimHold(key, value, ttlSec) {
      const result = await redis.eval(
        AI_BUDGET_CLAIM_HOLD_LUA,
        1,
        key,
        value,
        String(ttlSec),
      );
      if (!Array.isArray(result) || result.length < 2) {
        throw new CoreInvariantError(
          "ai-budget claimHold Redis script returned an unexpected value",
        );
      }
      const stored: unknown = result[1];
      if (typeof stored !== "string") {
        throw new CoreInvariantError(
          "ai-budget claimHold Redis script returned a non-string hold",
        );
      }
      return { created: Number(result[0]) === 1, value: stored };
    },
    async dropHold(key) {
      const result = await redis.eval(AI_BUDGET_DROP_HOLD_LUA, 1, key);
      return Number(result) === 1;
    },
  };
}

function parseTryAddResult(result: unknown): AiBudgetTryAddDecision {
  if (!Array.isArray(result) || result.length < 2) {
    throw new CoreInvariantError(
      "ai-budget tryAdd Redis script returned an unexpected value",
    );
  }
  return {
    allowed: Number(result[0]) === 1,
    spent: parseAiBudgetSpent(scriptSpentRaw(result[1])),
  };
}

function scriptSpentRaw(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}
