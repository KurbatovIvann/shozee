/**
 * In-memory stand-in for Redis secondary storage (tests and the T6 auth
 * suite). Production mounts {@link createRedisSecondaryStorage}.
 *
 * `getAndDelete` is atomic here because JavaScript is single-threaded; the
 * Redis client uses `GETDEL` for the same contract across processes.
 */
import { withKeyLock } from "@showzy/module-kit/key-lock";

import {
  hmacBetterAuthConsumeKey,
  requireAuthIpHmacSecret,
} from "./auth-ip-hmac.js";

export interface SecondaryStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  getAndDelete(key: string): Promise<string | null>;
}

/** Better Auth `customStorage.consume` rule (window is seconds). */
export interface AuthRateLimitRule {
  readonly window: number;
  readonly max: number;
}

export interface AuthRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfter: number | null;
}

/**
 * Atomic fixed-window consume for Better Auth's IP rate limiter.
 * Redis runs this as Lua INCR+EXPIRE; tests use the in-memory mutex store.
 * Both stores HMAC the Better Auth key before persist (SHO-147).
 */
export interface AuthRateLimitStore {
  consume(key: string, rule: AuthRateLimitRule): Promise<AuthRateLimitDecision>;
}

interface Entry {
  value: string;
  expiresAtMs: number | undefined;
}

export function createMemorySecondaryStorage(options?: {
  readonly now?: () => number;
}): SecondaryStorage {
  const now = options?.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    get(key) {
      return Promise.resolve(read(key));
    },
    set(key, value, ttlSeconds) {
      const expiresAtMs =
        ttlSeconds !== undefined && ttlSeconds > 0
          ? now() + ttlSeconds * 1000
          : undefined;
      entries.set(key, { value, expiresAtMs });
      return Promise.resolve();
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    getAndDelete(key) {
      const value = read(key);
      entries.delete(key);
      return Promise.resolve(value);
    },
  };
}

interface FixedWindowState {
  count: number;
  expiresAtMs: number;
}

/**
 * In-process atomic fixed-window consume. An await between read and write
 * still races two overlapping `consume` calls; the per-key mutex closes that.
 * Cross-process atomicity is Redis Lua INCR+EXPIRE. The map key is an HMAC
 * digest of the Better Auth preimage — never the raw `${ip}|${path}`.
 */
export function createMemoryAuthRateLimitStore(options: {
  readonly ipHmacSecret: string;
  /** Injectable clock (epoch milliseconds) for tests; defaults to Date.now. */
  readonly now?: () => number;
}): AuthRateLimitStore {
  const ipHmacSecret = requireAuthIpHmacSecret(options.ipHmacSecret);
  const now = options.now ?? Date.now;
  const windows = new Map<string, FixedWindowState>();
  const tails = new Map<string, Promise<void>>();

  return {
    consume(key, rule) {
      const digest = hmacBetterAuthConsumeKey(key, ipHmacSecret);
      return withKeyLock(tails, digest, (): Promise<AuthRateLimitDecision> => {
        const nowMs = now();
        const existing = windows.get(digest);
        const active =
          existing !== undefined && existing.expiresAtMs > nowMs
            ? existing
            : undefined;
        if (active === undefined) {
          windows.set(digest, {
            count: 1,
            expiresAtMs: nowMs + rule.window * 1000,
          });
          return Promise.resolve({ allowed: true, retryAfter: null });
        }
        if (active.count >= rule.max) {
          return Promise.resolve({
            allowed: false,
            retryAfter: Math.max(
              1,
              Math.ceil((active.expiresAtMs - nowMs) / 1000),
            ),
          });
        }
        active.count += 1;
        return Promise.resolve({ allowed: true, retryAfter: null });
      });
    },
  };
}
