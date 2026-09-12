/**
 * Staff-assistant daily USD counters (SHO-505). `tryAdd` is an
 * increment-with-cap (the reservation before the model). `add` releases: it
 * adds a signed amount, stops at zero, and deletes the key at zero or below
 * (SHO-561). Nothing settles a reservation against real spend — the
 * reservation is the charge (SHO-572). `claimHold` / `dropHold` record one turn's reservation
 * under the turn's own identity, so a retry of the same command finds the
 * reservation rather than taking a second one, and two parties releasing one
 * hold cannot subtract it twice (SHO-572). In Redis all of them are Lua
 * read-then-write scripts (`budget-redis.ts`); here they are serialized per
 * key. Tests use this in-memory store. Never GETDEL — that stays
 * confirmation's primitive.
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

/**
 * Where one turn's reservation is recorded, so a retry of the same command
 * finds it instead of taking a second one (SHO-572).
 *
 * **The key is the turn's identity.** Kind, conversation and command are
 * exactly what `assistant_turns` is keyed by; the company and the Kyiv day name
 * the counters the reservation sits in, both of which the turn row already
 * carries. So neither side stores a pointer to the other: the row, the accept
 * and this key are all derived from the same facts, and cannot name different
 * holds. That is what makes "who owns this reservation" one question with one
 * answer instead of several that can disagree.
 *
 * Lowercased for the same reason the message ids are: Postgres hands a `uuid`
 * back lowercase and Redis keys are case-sensitive, so `ABC…` and `abc…` must
 * reach the same key or a retry would reserve again.
 */
export function aiBudgetHoldKey(hold: {
  readonly companyId: string;
  readonly kyivDate: string;
  readonly kind: string;
  readonly conversationId: string;
  readonly commandId: string;
}): string {
  const company = canonicalizeAiBudgetCompanyId(hold.companyId);
  const conversation = hold.conversationId.toLowerCase();
  const command = hold.commandId.toLowerCase();
  return `ai-budget-hold:${company}:${hold.kyivDate}:${hold.kind}:${conversation}:${command}`;
}

export interface AiBudgetTryAddDecision {
  readonly allowed: boolean;
  readonly spent: number;
}

export interface AiBudgetHoldClaim {
  /** True when this call recorded the hold, false when one was already there. */
  readonly created: boolean;
  /** The hold that now stands: this call's `value`, or the one it found. */
  readonly value: string;
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
  /**
   * Record this hold under `key` unless one is already there, and say which
   * happened (SHO-572).
   *
   * Set-if-absent. The caller told `created` is the one that owns the
   * reservation; every later caller under the same key is told what the owner
   * recorded, and must not move the counters for it.
   */
  claimHold(
    key: string,
    value: string,
    ttlSec: number,
  ): Promise<AiBudgetHoldClaim>;
  /**
   * Forget a recorded hold, and say whether this call is the one that did it.
   *
   * Two parties releasing one hold — the request and the turn
   * row's finisher — therefore cannot subtract it twice, which is the way the
   * day's counter used to drift below real spend.
   */
  dropHold(key: string): Promise<boolean>;
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

interface MemoryHoldEntry {
  value: string;
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
  const holds = new Map<string, MemoryHoldEntry>();
  const tails = new Map<string, Promise<void>>();

  function liveHold(key: string): string | null {
    const entry = holds.get(key);
    if (entry === undefined || entry.expiresAtMs <= now()) {
      holds.delete(key);
      return null;
    }
    return entry.value;
  }

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

    claimHold(key, value, ttlSec) {
      return withKeyLock(tails, key, (): Promise<AiBudgetHoldClaim> => {
        const existing = liveHold(key);
        if (existing !== null) {
          return Promise.resolve({ created: false, value: existing });
        }
        holds.set(key, { value, expiresAtMs: now() + ttlSec * 1000 });
        return Promise.resolve({ created: true, value });
      });
    },

    dropHold(key) {
      return withKeyLock(tails, key, () =>
        Promise.resolve(liveHold(key) !== null && holds.delete(key)),
      );
    },
  };
}

export { parseSpent as parseAiBudgetSpent };
