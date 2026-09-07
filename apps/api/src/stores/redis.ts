/**
 * Redis adapters mounted by `apps/api` at boot (fnd-T26). Core stays
 * dependency-free: these implementations must match the in-memory
 * reference stores in `@showzy/core` (token-bucket continuous refill,
 * confirmation `GETDEL`).
 */
import {
  bindsMatch,
  parsePendingInteractionRecord,
  pendingBindOf,
  pendingIdOf,
  pendingKindOf,
  pendingRecordTtlMs,
  pendingRedisKey,
  pendingToChoiceRecord,
  serializePendingInteractionRecord,
  type PendingInteractionRecord,
} from "@showzy/ai";
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
import type { StaffAssistantChoiceStore } from "./choice.js";
import type { AuthRateLimitStore, SecondaryStorage } from "./memory.js";
import {
  bindPendingStoreBacking,
  createChoiceStoreFromPending,
  type PendingClaimDecision,
  type PendingCompleteDecision,
  type StaffAssistantPendingInteractionStore,
} from "./pending-interaction.js";

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
 * Atomic pending-interaction claim: exactly one transition out of `open`.
 * Confirmation uses resolution `confirmed`; choice uses optionId against
 * optionMap. Same resolution after claim/complete replays; a different
 * one is rejected. Never GETDEL — core's challenge keeps that primitive.
 */
const PENDING_CLAIM_LUA = `
local resolution = ARGV[1]
local actorId = ARGV[2]
local companyId = ARGV[3]
local conversationId = ARGV[4]
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
local isConfirmation = rec.kind == 'confirmation'
if isConfirmation then
  if resolution ~= 'confirmed' then
    return {-3}
  end
else
  if type(rec.optionMap) ~= 'table' or rec.optionMap[resolution] == nil then
    return {-3}
  end
end
local ttl = tonumber(redis.call('PTTL', KEYS[1]))
if ttl == nil or ttl < 1 then
  redis.call('DEL', KEYS[1])
  return {0}
end
if rec.status == 'open' then
  rec.status = 'claimed'
  if isConfirmation then
    rec.claimedResolution = resolution
  else
    rec.claimedOptionId = resolution
  end
  redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
  return {1, redis.call('GET', KEYS[1])}
end
if isConfirmation then
  if rec.claimedResolution == resolution then
    return {2, raw}
  end
else
  if rec.claimedOptionId == resolution then
    return {2, raw}
  end
end
return {-2}
`;

const PENDING_COMPLETE_LUA = `
local resolution = ARGV[1]
local actorId = ARGV[2]
local companyId = ARGV[3]
local conversationId = ARGV[4]
local resumeRaw = ARGV[5]
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
local isConfirmation = rec.kind == 'confirmation'
local claimed = isConfirmation and rec.claimedResolution or rec.claimedOptionId
if rec.status == 'completed' then
  if claimed == resolution then
    return {2, raw}
  end
  return {-2}
end
if rec.status ~= 'claimed' or claimed ~= resolution then
  return {-2}
end
rec.status = 'completed'
if type(resumeRaw) == 'string' and resumeRaw ~= '' then
  local rok, resume = pcall(cjson.decode, resumeRaw)
  if rok then
    rec.resumeResult = resume
  end
end
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ttl)
return {1, redis.call('GET', KEYS[1])}
`;

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

export function createRedisPendingInteractionStore(
  redis: Pick<Redis, "eval" | "get" | "set">,
  options?: { readonly ttlMs?: number },
): StaffAssistantPendingInteractionStore {
  function ttlMsFor(record: PendingInteractionRecord): number {
    if (options?.ttlMs !== undefined) {
      return options.ttlMs;
    }
    return pendingRecordTtlMs(pendingKindOf(record));
  }

  return {
    async open(record) {
      const result = await redis.set(
        pendingRedisKey(pendingKindOf(record), pendingIdOf(record)),
        serializePendingInteractionRecord({ ...record, status: "open" }),
        "PX",
        ttlMsFor(record),
        "NX",
      );
      return result === "OK";
    },

    async claim(input) {
      const result = await redis.eval(
        PENDING_CLAIM_LUA,
        1,
        pendingRedisKey(input.kind, input.id),
        input.resolution,
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
      );
      return parsePendingClaimResult(result);
    },

    async peek(input) {
      const raw = await redis.get(pendingRedisKey(input.kind, input.id));
      if (typeof raw !== "string" || raw === "") {
        return { kind: "expired" };
      }
      const record = parsePendingInteractionRecord(raw);
      if (record === undefined) {
        return { kind: "expired" };
      }
      if (!bindsMatch(pendingBindOf(record), input.bind)) {
        return { kind: "forbidden" };
      }
      if (pendingKindOf(record) !== "choice") {
        return { kind: "expired" };
      }
      return { kind: "found", record: pendingToChoiceRecord(record) };
    },

    async complete(input) {
      const resumeRaw =
        input.resumeResult === undefined
          ? ""
          : JSON.stringify(input.resumeResult);
      const result = await redis.eval(
        PENDING_COMPLETE_LUA,
        1,
        pendingRedisKey(input.kind, input.id),
        input.resolution,
        input.bind.actorId,
        input.bind.companyId,
        input.bind.conversationId,
        resumeRaw,
      );
      return parsePendingCompleteResult(result);
    },

    async get(input) {
      const raw = await redis.get(pendingRedisKey(input.kind, input.id));
      if (typeof raw !== "string" || raw === "") {
        return null;
      }
      return parsePendingInteractionRecord(raw) ?? null;
    },
  };
}

export function createRedisChoiceStore(
  redis: Pick<Redis, "eval" | "get" | "set">,
  options?: { readonly ttlMs?: number },
): StaffAssistantChoiceStore {
  const pending = createRedisPendingInteractionStore(redis, options);
  const choice = createChoiceStoreFromPending(pending);
  bindPendingStoreBacking(choice, pending);
  return choice;
}

function parsePendingScriptRecord(
  result: unknown,
): PendingInteractionRecord | undefined {
  if (!Array.isArray(result) || typeof result[1] !== "string") {
    return undefined;
  }
  return parsePendingInteractionRecord(result[1]);
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
