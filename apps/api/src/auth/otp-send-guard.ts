import { withKeyLock } from "@showzy/module-kit/key-lock";

import { otpPolicy } from "./policy.js";

export type OtpChannel = "phone" | "email";

export type OtpSendDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface OtpSendAttempt {
  readonly key: string;
  readonly nowMs: number;
  readonly cooldownMs: number;
  readonly windowMs: number;
  readonly maxSends: number;
  readonly ttlSeconds: number;
}

export interface OtpSendStore {
  tryRecordSend(attempt: OtpSendAttempt): Promise<OtpSendDecision>;
}

export interface OtpSendGuard {
  /**
   * Checks the per-identifier limits (60-second resend cooldown, 5 sends per
   * hour — security-operations §2) and, when allowed, records the send.
   */
  check(channel: OtpChannel, identifier: string): Promise<OtpSendDecision>;
}

export interface CreateOtpSendGuardOptions {
  readonly store: OtpSendStore;
  /** Injectable clock (epoch milliseconds) for tests; defaults to Date.now. */
  readonly now?: () => number;
}

interface GetSetStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

function normalizeIdentifier(channel: OtpChannel, identifier: string): string {
  const trimmed = identifier.trim();
  // Email addresses are case-insensitive identifiers; phone numbers pass
  // through (format validation is the endpoint's concern, not the guard's).
  return channel === "email" ? trimmed.toLowerCase() : trimmed;
}

/** Parses stored history defensively: corrupt state must never block sign-in. */
export function readOtpSendHistory(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is number => typeof entry === "number");
  } catch {
    return [];
  }
}

/**
 * Pure decision for one identifier. Callers must invoke this inside an
 * atomic read-modify-write (in-process mutex or Redis Lua).
 */
export function applyOtpSendAttempt(
  raw: string | null | undefined,
  attempt: Omit<OtpSendAttempt, "key" | "ttlSeconds">,
):
  | { readonly allowed: true; readonly nextRaw: string }
  | { readonly allowed: false; readonly retryAfterSeconds: number } {
  const windowStartMs = attempt.nowMs - attempt.windowMs;
  const history =
    raw === null || raw === undefined ? [] : readOtpSendHistory(raw);
  const recent = history.filter((sentAt) => sentAt > windowStartMs);

  const lastSentAt = recent.at(-1);
  if (lastSentAt !== undefined) {
    const cooldownEndsMs = lastSentAt + attempt.cooldownMs;
    if (attempt.nowMs < cooldownEndsMs) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((cooldownEndsMs - attempt.nowMs) / 1000),
      };
    }
  }

  if (recent.length >= attempt.maxSends) {
    const oldest = recent[0] ?? attempt.nowMs;
    const windowFreesMs = oldest + attempt.windowMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowFreesMs - attempt.nowMs) / 1000),
      ),
    };
  }

  recent.push(attempt.nowMs);
  return { allowed: true, nextRaw: JSON.stringify(recent) };
}

/**
 * In-process atomic wrapper over get/set. JavaScript is single-threaded, but
 * an await between read and write still races two overlapping `check` calls;
 * the per-key mutex closes that. Cross-process atomicity is Redis Lua.
 */
export function createAtomicOtpSendStore(backing: GetSetStore): OtpSendStore {
  const tails = new Map<string, Promise<void>>();
  return {
    tryRecordSend(attempt) {
      return withKeyLock(tails, attempt.key, async () => {
        const raw = await backing.get(attempt.key);
        const decision = applyOtpSendAttempt(raw, attempt);
        if (decision.allowed) {
          await backing.set(attempt.key, decision.nextRaw, attempt.ttlSeconds);
          return { allowed: true as const };
        }
        return {
          allowed: false as const,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      });
    },
  };
}

export function createMemoryOtpSendStore(): OtpSendStore & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  const store = createAtomicOtpSendStore({
    get(key) {
      return Promise.resolve(entries.get(key) ?? null);
    },
    set(key, value) {
      entries.set(key, value);
      return Promise.resolve();
    },
  });
  return { entries, tryRecordSend: (attempt) => store.tryRecordSend(attempt) };
}

/**
 * Per-identifier OTP send throttle. better-auth's own rate limiter is keyed
 * by client IP, so the per-phone/per-email limits required by
 * security-operations §2 live here; the guard is wired as a better-auth
 * `hooks.before` middleware in `options.ts`, ahead of OTP creation.
 *
 * Recording a send is atomic: in-memory stores serialize per key, and the
 * Redis store (fnd-T26) evaluates cooldown + hourly cap in one Lua script.
 */
export function createOtpSendGuard(
  options: CreateOtpSendGuardOptions,
): OtpSendGuard {
  const now = options.now ?? Date.now;

  return {
    async check(channel, identifier) {
      const key = `otp-send:${channel}:${normalizeIdentifier(channel, identifier)}`;
      return options.store.tryRecordSend({
        key,
        nowMs: now(),
        cooldownMs: otpPolicy.resendCooldownSeconds * 1000,
        windowMs: otpPolicy.sendWindowSeconds * 1000,
        maxSends: otpPolicy.maxSendsPerHourPerIdentifier,
        ttlSeconds: otpPolicy.sendWindowSeconds,
      });
    },
  };
}
