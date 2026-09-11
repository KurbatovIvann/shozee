/**
 * The staff-assistant budget counters on Redis (SHO-505). Here rather than in
 * `apps/api` since SHO-561: a turn is settled or released by the worker too,
 * and it must move the same counters the accept reserved on.
 *
 * It matches `createMemoryAiBudgetStore`, the reference store: `tryAdd` is an
 * increment-with-cap, and `add` never leaves a counter below zero. Both are Lua
 * so each read-then-write is atomic, and both store a plain decimal string an
 * operator can GET, SET or DEL.
 */
import { CoreInvariantError } from "@showzy/core/errors";
import type { Redis } from "ioredis";

import {
  parseAiBudgetSpent,
  type AiBudgetStore,
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
 * that much — its key expired with the Kyiv day, or an operator reset it — a
 * plain `INCRBYFLOAT` would leave it negative, and a negative counter lifts the
 * day's cap by that amount. At zero or below the key is deleted, as the memory
 * store deletes it; a missing key reads as zero.
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
  return '0'
end
local stored = string.format('%.17g', nxt)
redis.call('SET', KEYS[1], stored, 'EX', ttlSec)
return stored
`;

export function createRedisAiBudgetStore(
  redis: Pick<Redis, "get" | "eval">,
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
      return parseAiBudgetSpent(scriptSpentRaw(result));
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
