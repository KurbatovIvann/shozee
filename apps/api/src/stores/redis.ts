/**
 * Redis adapters mounted by `apps/api` at boot (fnd-T26). Core stays
 * dependency-free: these implementations must match the in-memory
 * reference stores in `@showzy/core` (token-bucket continuous refill,
 * confirmation `GETDEL`).
 */
import {
  bindsMatch,
  conversationPendingIndexPayload,
  parseConversationPendingIndex,
  parsePendingRecord,
  pendingConversationIndexKey,
  pendingRecordBind,
  pendingRedisKey,
  pendingTtlMs,
  serializePendingRecord,
  type PendingInteractionRecord,
} from "@showzy/ai";
import { randomUUID } from "node:crypto";

import type { ConfirmationStore, RateLimitStore } from "@showzy/core";
import type { Redis } from "ioredis";

import type { OtpSendStore } from "../auth/otp-send-guard.js";
import {
  hmacBetterAuthConsumeKey,
  requireAuthIpHmacSecret,
} from "./auth-ip-hmac.js";
import {
  parseAiBudgetSpent,
  type AiBudgetStore,
  type AiBudgetTryAddDecision,
} from "./budget.js";
import {
  CONVERSATION_LOCK_TTL_MS,
  CONVERSATION_LOCK_WAIT_MS,
  conversationLockRedisKey as conversationLockKey,
  conversationLockRenewEveryMs,
  type ConversationLock,
} from "./conversation-lock.js";
import type {
  PendingAbandonDecision,
  PendingClaimDecision,
  PendingCompleteDecision,
  PendingReplaceDecision,
  StaffAssistantPendingStore,
} from "./pending.js";
import type { AuthRateLimitStore, SecondaryStorage } from "./memory.js";

/** Adapter failure — the rate-limit/confirmation hooks own fail-open/closed. */
export class RedisStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisStoreError";
  }
}

const TOKEN_BUCKET_LUA = `
local limit = tonumber(ARGV[1])
local windowSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAtMs')
local tokens = tonumber(data[1])
local updatedAtMs = tonumber(data[2])

if tokens == nil then
  tokens = limit
  updatedAtMs = nowMs
end

local elapsedMs = math.max(0, nowMs - updatedAtMs)
local refill = (elapsedMs / 1000.0) * (limit / windowSec)
tokens = math.min(limit, tokens + refill)

if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAtMs', nowMs)
  redis.call('EXPIRE', KEYS[1], math.ceil(windowSec * 2))
  local secondsPerToken = windowSec / limit
  local retryAfterSec = math.max(1, math.ceil((1 - tokens) * secondsPerToken))
  return {0, retryAfterSec}
end

tokens = tokens - 1
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAtMs', nowMs)
redis.call('EXPIRE', KEYS[1], math.ceil(windowSec * 2))
return {1, 0}
`;

const OTP_SEND_LUA = `
local nowMs = tonumber(ARGV[1])
local cooldownMs = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])
local maxSends = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])
local windowStart = nowMs - windowMs
local raw = redis.call('GET', KEYS[1])
local recent = {}
if type(raw) == 'string' and raw ~= '' then
  local ok, parsed = pcall(cjson.decode, raw)
  if ok and type(parsed) == 'table' then
    for i = 1, #parsed do
      local ts = tonumber(parsed[i])
      if ts ~= nil and ts > windowStart then
        table.insert(recent, ts)
      end
    end
  end
end
if #recent > 0 then
  local last = recent[#recent]
  local cooldownEnds = last + cooldownMs
  if nowMs < cooldownEnds then
    return {0, math.ceil((cooldownEnds - nowMs) / 1000)}
  end
end
if #recent >= maxSends then
  local oldest = recent[1]
  local wait = math.max(1, math.ceil((oldest + windowMs - nowMs) / 1000))
  return {0, wait}
end
table.insert(recent, nowMs)
redis.call('SET', KEYS[1], cjson.encode(recent), 'EX', ttlSec)
return {1, 0}
`;

/**
 * Fixed-window INCR + EXPIRE for Better Auth `customStorage.consume`.
 * First hit opens the window (EXPIRE = window seconds); later hits INCR.
 * Over the cap returns the remaining TTL as retry-after.
 */
const AUTH_RATE_LIMIT_LUA = `
local max = tonumber(ARGV[1])
local windowSec = tonumber(ARGV[2])
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], windowSec)
end
if count <= max then
  return {1, 0}
end
local ttl = tonumber(redis.call('TTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  ttl = windowSec
end
return {0, ttl}
`;

/**
 * Open a pending record and the conversation index together. A live
 * conversation index is a parallel pending — refuse.
 */
const PENDING_OPEN_LUA = `
local indexRaw = redis.call('GET', KEYS[2])
if type(indexRaw) == 'string' and indexRaw ~= '' then
  return {0}
end
-- Redis 8 Lua SET NX returns a truthy status, not always the string OK.
local nx = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if not nx then
  return {0}
end
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
return {1}
`;

const PENDING_CLAIM_LUA = `
local actorId = ARGV[1]
local companyId = ARGV[2]
local conversationId = ARGV[3]
local optionId = ARGV[4]
local raw = redis.call('GET', KEYS[1])
if type(raw) ~= 'string' or raw == '' then
  return {0}
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.actorId ~= actorId or rec.companyId ~= companyId or rec.conversationId ~= conversationId then
  return {-1}
end
if rec.status == 'abandoned' or rec.status == 'superseded' then
  return {0}
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.kind == 'choice' then
  if optionId == nil or optionId == '' or type(rec.optionMap) ~= 'table' or rec.optionMap[optionId] == nil then
    return {-3}
  end
  if rec.status == 'open' then
    rec.status = 'claimed'
    rec.claimedOptionId = optionId
    redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
    return {1, redis.call('GET', KEYS[1])}
  end
  if rec.claimedOptionId == optionId then
    return {2, raw}
  end
  return {-2}
end
if rec.status == 'open' then
  rec.status = 'claimed'
  redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
  return {1, redis.call('GET', KEYS[1])}
end
if rec.status == 'claimed' or rec.status == 'completed' then
  return {2, raw}
end
return {0}
`;

const PENDING_COMPLETE_LUA = `
local actorId = ARGV[1]
local companyId = ARGV[2]
local conversationId = ARGV[3]
local optionId = ARGV[4]
local raw = redis.call('GET', KEYS[1])
if type(raw) ~= 'string' or raw == '' then
  return {0}
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.actorId ~= actorId or rec.companyId ~= companyId or rec.conversationId ~= conversationId then
  return {-1}
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.status == 'completed' then
  if rec.kind ~= 'choice' or rec.claimedOptionId == optionId then
    return {2, raw}
  end
  return {-2}
end
if rec.status ~= 'claimed' then
  return {-2}
end
if rec.kind == 'choice' and rec.claimedOptionId ~= optionId then
  return {-2}
end
rec.status = 'completed'
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
local indexRaw = redis.call('GET', KEYS[2])
if type(indexRaw) == 'string' and indexRaw ~= '' then
  local iok, idx = pcall(cjson.decode, indexRaw)
  if iok and type(idx) == 'table' and idx.id == rec.id then
    redis.call('DEL', KEYS[2])
  end
end
return {1, redis.call('GET', KEYS[1])}
`;

const PENDING_ABANDON_LUA = `
local actorId = ARGV[1]
local companyId = ARGV[2]
local conversationId = ARGV[3]
local expectedVersion = tonumber(ARGV[4])
local raw = redis.call('GET', KEYS[1])
if type(raw) ~= 'string' or raw == '' then
  return {0}
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.actorId ~= actorId or rec.companyId ~= companyId or rec.conversationId ~= conversationId then
  return {-1}
end
if tonumber(rec.version) ~= expectedVersion then
  return {0}
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.status == 'abandoned' then
  return {2, raw}
end
if rec.status ~= 'open' and rec.status ~= 'claimed' then
  return {0}
end
rec.status = 'abandoned'
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
local indexRaw = redis.call('GET', KEYS[2])
if type(indexRaw) == 'string' and indexRaw ~= '' then
  local iok, idx = pcall(cjson.decode, indexRaw)
  if iok and type(idx) == 'table' and idx.id == rec.id then
    redis.call('DEL', KEYS[2])
  end
end
return {1, redis.call('GET', KEYS[1])}
`;

const PENDING_REPLACE_LUA = `
local actorId = ARGV[1]
local companyId = ARGV[2]
local conversationId = ARGV[3]
local expectedVersion = tonumber(ARGV[4])
local newTtl = tonumber(ARGV[7])
local raw = redis.call('GET', KEYS[1])
if type(raw) ~= 'string' or raw == '' then
  return {0}
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.actorId ~= actorId or rec.companyId ~= companyId or rec.conversationId ~= conversationId then
  return {-1}
end
if tonumber(rec.version) ~= expectedVersion then
  return {0}
end
if rec.status ~= 'open' then
  return {0}
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  redis.call('DEL', KEYS[1])
  return {0}
end
redis.call('SET', KEYS[1], ARGV[5], 'PX', ttl)
redis.call('SET', KEYS[2], ARGV[6], 'PX', newTtl)
redis.call('SET', KEYS[3], ARGV[8], 'PX', newTtl)
return {1, ARGV[5], ARGV[6]}
`;

const CONVERSATION_LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const CONVERSATION_LOCK_RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * ioredis historically returns the string OK. Redis 8 Lua SET NX is
 * truthy (boolean/integer), not always the string OK — match PENDING_OPEN_LUA.
 */
export function redisSetNxSucceeded(result: unknown): boolean {
  return result === "OK" || result === true || result === 1;
}

type ConversationLockRedis = {
  set(
    key: string,
    value: string,
    px: "PX",
    ttlMs: number,
    nx: "NX",
  ): Promise<unknown>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createRedisSecondaryStorage(redis: Redis): SecondaryStorage {
  return {
    get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await redis.set(key, value, "EX", ttlSeconds);
        return;
      }
      await redis.set(key, value);
    },
    async delete(key) {
      await redis.del(key);
    },
    async getAndDelete(key) {
      const value = await redis.call("GETDEL", key);
      return typeof value === "string" ? value : null;
    },
  };
}

export function createRedisConfirmationStore(redis: Redis): ConfirmationStore {
  return {
    async set(key, value, ttlMs) {
      await redis.set(key, value, "PX", ttlMs);
    },
    async getAndDelete(key) {
      const value = await redis.call("GETDEL", key);
      return typeof value === "string" ? value : null;
    },
  };
}

export function createRedisOtpSendStore(redis: Redis): OtpSendStore {
  return {
    async tryRecordSend(attempt) {
      const result = await redis.eval(
        OTP_SEND_LUA,
        1,
        attempt.key,
        String(attempt.nowMs),
        String(attempt.cooldownMs),
        String(attempt.windowMs),
        String(attempt.maxSends),
        String(attempt.ttlSeconds),
      );
      return parseOtpSendResult(result);
    },
  };
}

/**
 * Better Auth IP / path rate-limit consume. Fail-closed on Redis errors:
 * OTP send is public/auth abuse (security-operations §2) — never send SMS
 * when the limiter cannot decide. Never log the consume preimage (it
 * contains the client IP); Redis stores an HMAC digest, not the address.
 */
export function createRedisAuthRateLimitStore(
  redis: Pick<Redis, "eval">,
  options: { readonly ipHmacSecret: string },
): AuthRateLimitStore {
  const ipHmacSecret = requireAuthIpHmacSecret(options.ipHmacSecret);
  return {
    async consume(key, rule) {
      const digest = hmacBetterAuthConsumeKey(key, ipHmacSecret);
      try {
        const result = await redis.eval(
          AUTH_RATE_LIMIT_LUA,
          1,
          digest,
          String(rule.max),
          String(rule.window),
        );
        return parseAuthRateLimitResult(result, rule.window);
      } catch {
        return failClosedAuthRateLimit(rule.window);
      }
    },
  };
}

export function createRedisRateLimitStore(
  redis: Redis,
  options?: { readonly now?: () => number },
): RateLimitStore {
  const now = options?.now ?? Date.now;
  return {
    async consume(request) {
      const result = await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        request.key,
        String(request.limit),
        String(request.windowSec),
        String(now()),
      );
      return parseTokenBucketResult(result);
    },
  };
}

/**
 * Atomic increment-with-cap for a Kyiv-day USD reservation (SHO-505
 * amendment). Settlement still uses INCRBYFLOAT + EXPIRE so an operator
 * can GET/SET/DEL the key.
 */
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
 * Daily USD counters: `tryAdd` is Lua increment-with-cap; `add` is
 * INCRBYFLOAT then EXPIRE (settlement / release). A lost EXPIRE still
 * leaves a key an operator can DEL (SHO-505).
 */
export function createRedisAiBudgetStore(
  redis: Pick<Redis, "get" | "incrbyfloat" | "expire" | "eval">,
): AiBudgetStore {
  return {
    async read(key) {
      return parseAiBudgetSpent(await redis.get(key));
    },
    async add(key, amountUsd, ttlSec) {
      const next = await redis.incrbyfloat(key, amountUsd);
      await redis.expire(key, ttlSec);
      return parseAiBudgetSpent(next);
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
      return parseAiBudgetTryAddResult(result);
    },
  };
}

export function createRedisConversationLock(
  redis: ConversationLockRedis,
  options?: {
    readonly ttlMs?: number;
    readonly waitMs?: number;
    readonly renewEveryMs?: number;
    readonly retryDelayMs?: number;
  },
): ConversationLock {
  const ttlMs = options?.ttlMs ?? CONVERSATION_LOCK_TTL_MS;
  const waitMs = options?.waitMs ?? CONVERSATION_LOCK_WAIT_MS;
  const renewEveryMs =
    options?.renewEveryMs ?? conversationLockRenewEveryMs(ttlMs);
  const retryDelayMs = options?.retryDelayMs ?? 15;
  return {
    async withLock(conversationId, work) {
      const token = randomUUID();
      const key = conversationLockKey(conversationId);
      const deadline = Date.now() + waitMs;
      let acquired = false;
      let timedOut = false;
      while (!acquired && !timedOut) {
        const result = await redis.set(key, token, "PX", ttlMs, "NX");
        if (redisSetNxSucceeded(result)) {
          acquired = true;
        } else if (Date.now() >= deadline) {
          timedOut = true;
        } else {
          await sleep(retryDelayMs);
        }
      }
      if (!acquired) {
        throw new RedisStoreError("conversation lock timed out");
      }
      const renew = setInterval(() => {
        void redis.eval(
          CONVERSATION_LOCK_RENEW_LUA,
          1,
          key,
          token,
          String(ttlMs),
        );
      }, renewEveryMs);
      try {
        return await work();
      } finally {
        clearInterval(renew);
        await redis.eval(CONVERSATION_LOCK_RELEASE_LUA, 1, key, token);
      }
    },
  };
}

export function createRedisPendingStore(
  redis: Pick<Redis, "eval" | "get" | "set">,
): StaffAssistantPendingStore {
  async function loadById(
    id: string,
    kind?: PendingInteractionRecord["kind"],
  ): Promise<
    | { readonly key: string; readonly record: PendingInteractionRecord }
    | undefined
  > {
    const kinds =
      kind === undefined
        ? (["choice", "confirmation"] as const)
        : ([kind] as const);
    for (const candidate of kinds) {
      const key = pendingRedisKey(candidate, id);
      const raw = await redis.get(key);
      if (typeof raw !== "string" || raw === "") {
        continue;
      }
      const record = parsePendingRecord(raw);
      if (record !== undefined) {
        return { key, record };
      }
    }
    return undefined;
  }

  return {
    async open(record) {
      const opened: PendingInteractionRecord = { ...record, status: "open" };
      const result = await redis.eval(
        PENDING_OPEN_LUA,
        2,
        pendingRedisKey(opened.kind, opened.id),
        pendingConversationIndexKey(opened.conversationId),
        serializePendingRecord(opened),
        String(pendingTtlMs(opened.kind)),
        conversationPendingIndexPayload(opened),
      );
      return Array.isArray(result) && Number(result[0]) === 1;
    },

    async claim(input) {
      const result = await redis.eval(
        PENDING_CLAIM_LUA,
        1,
        pendingRedisKey(input.kind, input.id),
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
        input.optionId ?? "",
      );
      return parsePendingClaimResult(result);
    },

    async peek(input) {
      const found = await loadById(input.id, input.kind);
      if (found === undefined) {
        return { kind: "expired" };
      }
      if (!bindsMatch(pendingRecordBind(found.record), input.bind)) {
        return { kind: "forbidden" };
      }
      return { kind: "found", record: found.record };
    },

    async peekOpen(input) {
      const raw = await redis.get(
        pendingConversationIndexKey(input.conversationId),
      );
      if (typeof raw !== "string" || raw === "") {
        return { kind: "empty" };
      }
      const parsed = parseConversationPendingIndex(raw);
      if (parsed === undefined) {
        return { kind: "empty" };
      }
      const recordRaw = await redis.get(
        pendingRedisKey(parsed.kind, parsed.id),
      );
      if (typeof recordRaw !== "string" || recordRaw === "") {
        return { kind: "empty" };
      }
      const record = parsePendingRecord(recordRaw);
      if (
        record === undefined ||
        (record.status !== "open" && record.status !== "claimed")
      ) {
        return { kind: "empty" };
      }
      if (!bindsMatch(pendingRecordBind(record), input.bind)) {
        return { kind: "empty" };
      }
      return { kind: "found", record };
    },

    async complete(input) {
      const result = await redis.eval(
        PENDING_COMPLETE_LUA,
        2,
        pendingRedisKey(input.kind, input.id),
        pendingConversationIndexKey(input.bind.conversationId),
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
        input.optionId ?? "",
      );
      return parsePendingCompleteResult(result);
    },

    async abandon(input) {
      const found = await loadById(input.id);
      if (found === undefined) {
        return { kind: "expired" };
      }
      const result = await redis.eval(
        PENDING_ABANDON_LUA,
        2,
        found.key,
        pendingConversationIndexKey(input.bind.conversationId),
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
        String(input.expectedVersion),
      );
      return parsePendingAbandonResult(result);
    },

    async replace(input) {
      const found = await loadById(input.id);
      if (found === undefined) {
        return { kind: "expired" };
      }
      const superseded: PendingInteractionRecord = {
        ...found.record,
        status: "superseded",
      };
      const opened: PendingInteractionRecord = {
        ...input.next,
        status: "open",
      };
      const result = await redis.eval(
        PENDING_REPLACE_LUA,
        3,
        found.key,
        pendingRedisKey(opened.kind, opened.id),
        pendingConversationIndexKey(input.bind.conversationId),
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
        String(input.expectedVersion),
        serializePendingRecord(superseded),
        serializePendingRecord(opened),
        String(pendingTtlMs(opened.kind)),
        conversationPendingIndexPayload(opened),
      );
      return parsePendingReplaceResult(result, superseded, opened);
    },
  };
}

function parsePendingScriptRecord(
  result: unknown,
): PendingInteractionRecord | undefined {
  if (!Array.isArray(result) || typeof result[1] !== "string") {
    return undefined;
  }
  return parsePendingRecord(result[1]);
}

function parsePendingClaimResult(result: unknown): PendingClaimDecision {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "pending-claim Redis script returned an unexpected value",
    );
  }
  const code = Number(result[0]);
  if (code === 0) {
    return { kind: "expired" };
  }
  if (code === -1) {
    return { kind: "forbidden" };
  }
  if (code === -2) {
    return { kind: "conflict" };
  }
  if (code === -3) {
    return { kind: "invalid_option" };
  }
  const record = parsePendingScriptRecord(result);
  if (record === undefined) {
    throw new RedisStoreError(
      "pending-claim Redis script returned an unreadable record",
    );
  }
  if (code === 1) {
    return { kind: "claimed", record };
  }
  if (code === 2) {
    return { kind: "replay", record };
  }
  throw new RedisStoreError(
    "pending-claim Redis script returned an unexpected code",
  );
}

function parsePendingCompleteResult(result: unknown): PendingCompleteDecision {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "pending-complete Redis script returned an unexpected value",
    );
  }
  const code = Number(result[0]);
  if (code === 0) {
    return { kind: "expired" };
  }
  if (code === -1) {
    return { kind: "forbidden" };
  }
  if (code === -2) {
    return { kind: "conflict" };
  }
  const record = parsePendingScriptRecord(result);
  if (record === undefined) {
    throw new RedisStoreError(
      "pending-complete Redis script returned an unreadable record",
    );
  }
  if (code === 1) {
    return { kind: "completed", record };
  }
  if (code === 2) {
    return { kind: "replay", record };
  }
  throw new RedisStoreError(
    "pending-complete Redis script returned an unexpected code",
  );
}

function parsePendingAbandonResult(result: unknown): PendingAbandonDecision {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "pending-abandon Redis script returned an unexpected value",
    );
  }
  const code = Number(result[0]);
  if (code === 0) {
    return { kind: "expired" };
  }
  if (code === -1) {
    return { kind: "forbidden" };
  }
  const record = parsePendingScriptRecord(result);
  if (record === undefined) {
    throw new RedisStoreError(
      "pending-abandon Redis script returned an unreadable record",
    );
  }
  if (code === 1) {
    return { kind: "abandoned", record };
  }
  if (code === 2) {
    return { kind: "replay", record };
  }
  throw new RedisStoreError(
    "pending-abandon Redis script returned an unexpected code",
  );
}

function parsePendingReplaceResult(
  result: unknown,
  previous: PendingInteractionRecord,
  next: PendingInteractionRecord,
): PendingReplaceDecision {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "pending-replace Redis script returned an unexpected value",
    );
  }
  const code = Number(result[0]);
  if (code === 0) {
    return { kind: "expired" };
  }
  if (code === -1) {
    return { kind: "forbidden" };
  }
  if (code === 1) {
    return { kind: "replaced", previous, record: next };
  }
  throw new RedisStoreError(
    "pending-replace Redis script returned an unexpected code",
  );
}

function parseAiBudgetTryAddResult(result: unknown): AiBudgetTryAddDecision {
  if (!Array.isArray(result) || result.length < 2) {
    throw new RedisStoreError(
      "ai-budget tryAdd Redis script returned an unexpected value",
    );
  }
  const allowedFlag = Number(result[0]);
  return {
    allowed: allowedFlag === 1,
    spent: parseAiBudgetSpent(aiBudgetScriptSpentRaw(result[1])),
  };
}

function aiBudgetScriptSpentRaw(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function parseTokenBucketResult(
  result: unknown,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSec: number } {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "rate-limit Redis script returned an unexpected value",
    );
  }
  const allowedFlag = Number(result[0]);
  if (allowedFlag === 1) {
    return { allowed: true };
  }
  const retryAfterSec = Number(result[1]);
  return {
    allowed: false,
    retryAfterSec:
      Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1,
  };
}

function failClosedAuthRateLimit(windowSec: number): {
  readonly allowed: false;
  readonly retryAfter: number;
} {
  return {
    allowed: false,
    retryAfter: Math.max(1, windowSec),
  };
}

function parseAuthRateLimitResult(
  result: unknown,
  windowSec: number,
):
  | { readonly allowed: true; readonly retryAfter: null }
  | { readonly allowed: false; readonly retryAfter: number } {
  if (!Array.isArray(result) || result.length === 0) {
    return failClosedAuthRateLimit(windowSec);
  }
  const allowedFlag = Number(result[0]);
  if (allowedFlag === 1) {
    return { allowed: true, retryAfter: null };
  }
  const retryAfter = Number(result[1]);
  return {
    allowed: false,
    retryAfter:
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : windowSec,
  };
}

function parseOtpSendResult(
  result: unknown,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number } {
  if (!Array.isArray(result) || result.length === 0) {
    throw new RedisStoreError(
      "otp-send Redis script returned an unexpected value",
    );
  }
  const allowedFlag = Number(result[0]);
  if (allowedFlag === 1) {
    return { allowed: true };
  }
  const retryAfterSeconds = Number(result[1]);
  return {
    allowed: false,
    retryAfterSeconds:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : 1,
  };
}
