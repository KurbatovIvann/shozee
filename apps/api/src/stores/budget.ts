/**
 * Staff-assistant daily USD counters (SHO-505). Redis uses INCRBYFLOAT +
 * EXPIRE (no Lua). Tests use the in-memory store. Never GETDEL — that
 * stays confirmation's primitive.
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

export interface AiBudgetStore {
  read(key: string): Promise<number>;
  add(key: string, amountUsd: number, ttlSec: number): Promise<number>;
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

  return {
    read(key) {
      return Promise.resolve(liveValue(key));
    },

    add(key, amountUsd, ttlSec) {
      return withKeyLock(tails, key, () => {
        const next = liveValue(key) + amountUsd;
        entries.set(key, {
          value: next,
          expiresAtMs: now() + ttlSec * 1000,
        });
        return Promise.resolve(next);
      });
    },
  };
}

export { parseSpent as parseAiBudgetSpent };
