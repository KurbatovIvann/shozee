/**
 * Staff-assistant daily USD counters (SHO-505). `tryAdd` is an
 * increment-with-cap (the reservation before the model). `add` settles or
 * releases: it adds a signed amount, stops at zero, and deletes the key at zero
 * or below (SHO-561). In Redis both are Lua read-then-write scripts
 * (`budget-redis.ts`); here they are serialized per key. Tests use this
 * in-memory store. Never GETDEL — that stays confirmation's primitive.
 */
import { withKeyLock } from "@showzy/module-kit/key-lock";

/** Keep Kyiv-day counters past midnight so operators can inspect yesterday. */
export const AI_BUDGET_TTL_SEC = 48 * 60 * 60;

export const AI_CHAT_TURN_WINDOW_SEC = 60;

export function aiChatTurnLimitKey(userId: string): string {
  return `ai-chat:${userId}`;
}

/**
 * Postgres UUID compare is case-insensitive; Redis keys are not.
 * Budget keys and denial `company_id` logs use this spelling. Not an
 * access grant — tenant scope stays verified staff membership.
 */
export function canonicalizeAiBudgetCompanyId(companyId: string): string {
  return companyId.toLowerCase();
}

export function aiCompanyBudgetKey(
  companyId: string,
  kyivDate: string,
): string {
  return `ai-budget:${canonicalizeAiBudgetCompanyId(companyId)}:${kyivDate}`;
}

export function aiGlobalBudgetKey(kyivDate: string): string {
  return `ai-budget:global:${kyivDate}`;
}

export interface AiBudgetTryAddDecision {
  readonly allowed: boolean;
  readonly spent: number;
}

export interface AiBudgetStore {
  read(key: string): Promise<number>;
  add(key: string, amountUsd: number, ttlSec: number): Promise<number>;
  /**
   * Atomically add `amountUsd` only when `current + amountUsd <= capUsd`.
   * Serializes overlapping reservations for the same key.
   */
  tryAdd(
    key: string,
    amountUsd: number,
    capUsd: number,
    ttlSec: number,
  ): Promise<AiBudgetTryAddDecision>;
}

/**
 * Where a budget store reports a counter it had to stop at zero. A process
 * logger (pino) fits.
 */
export interface AiBudgetStoreLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export const AI_BUDGET_FLOORED_MESSAGE =
  "staff assistant budget counter floored at zero";

/**
 * A release larger than what the counter holds — a hold released twice, or a
 * key reset under turns still in flight — would otherwise vanish into the
 * floor. The key names a company and a day; no person and no message.
 */
export function logAiBudgetFloored(
  logger: AiBudgetStoreLogger | undefined,
  floored: {
    readonly key: string;
    readonly currentUsd: number;
    readonly deltaUsd: number;
  },
): void {
  logger?.warn(
    {
      budget_key: floored.key,
      current_usd: floored.currentUsd,
      delta_usd: floored.deltaUsd,
    },
    AI_BUDGET_FLOORED_MESSAGE,
  );
}

interface MemoryBudgetEntry {
  value: number;
  expiresAtMs: number;
}

function parseSpent(raw: string | number | null): number {
  if (raw === null || raw === "") {
    return 0;
  }
  const spent = Number(raw);
  return Number.isFinite(spent) && spent > 0 ? spent : 0;
}

function clampSpent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function createMemoryAiBudgetStore(options?: {
  readonly now?: () => number;
  /** Told when a release had to stop a non-zero counter at zero. */
  readonly logger?: AiBudgetStoreLogger;
}): AiBudgetStore {
  const now = options?.now ?? Date.now;
  const entries = new Map<string, MemoryBudgetEntry>();
  const tails = new Map<string, Promise<void>>();

  function liveValue(key: string): number {
    const entry = entries.get(key);
    if (entry === undefined || entry.expiresAtMs <= now()) {
      entries.delete(key);
      return 0;
    }
    return entry.value;
  }

  function write(key: string, value: number, ttlSec: number): number {
    const spent = clampSpent(value);
    if (spent === 0) {
      entries.delete(key);
      return 0;
    }
    entries.set(key, {
      value: spent,
      expiresAtMs: now() + ttlSec * 1000,
    });
    return spent;
  }

  return {
    read(key) {
      return Promise.resolve(liveValue(key));
    },

    add(key, amountUsd, ttlSec) {
      return withKeyLock(tails, key, () => {
        const current = liveValue(key);
        const next = current + amountUsd;
        if (next < 0 && current > 0) {
          logAiBudgetFloored(options?.logger, {
            key,
            currentUsd: current,
            deltaUsd: amountUsd,
          });
        }
        return Promise.resolve(write(key, next, ttlSec));
      });
    },

    tryAdd(key, amountUsd, capUsd, ttlSec) {
      return withKeyLock(tails, key, (): Promise<AiBudgetTryAddDecision> => {
        const current = liveValue(key);
        const next = current + amountUsd;
        if (next > capUsd) {
          return Promise.resolve({ allowed: false, spent: current });
        }
        return Promise.resolve({
          allowed: true,
          spent: write(key, next, ttlSec),
        });
      });
    },
  };
}

export { parseSpent as parseAiBudgetSpent };
