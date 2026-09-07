/**
 * Staff-assistant daily USD counters (SHO-505). Redis `tryAdd` is Lua
 * increment-with-cap (reservation before the model). Settlement uses
 * INCRBYFLOAT + EXPIRE. Tests use the in-memory store. Never GETDEL —
 * that stays confirmation's primitive.
 */
import { withKeyLock } from "./with-key-lock.js";

/** Keep Kyiv-day counters past midnight so operators can inspect yesterday. */
export const AI_BUDGET_TTL_SEC = 48 * 60 * 60;

export const AI_CHAT_TURN_WINDOW_SEC = 60;

export function aiChatTurnLimitKey(userId: string): string {
  return `ai-chat:${userId}`;
}

export function aiCompanyBudgetKey(
  companyId: string,
  kyivDate: string,
): string {
  return `ai-budget:${companyId}:${kyivDate}`;
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
        return Promise.resolve(write(key, liveValue(key) + amountUsd, ttlSec));
      });
    },

    tryAdd(key, amountUsd, capUsd, ttlSec) {
      return withKeyLock(tails, key, () => {
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
