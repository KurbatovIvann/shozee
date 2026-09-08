/**
 * Per-conversation mutex shared by host chat, replace, abandon, and
 * resume (SHO-522). CAS on one pending record is not enough.
 *
 * In-memory uses the same per-key mutex as choice/OTP stores (no TTL).
 * Redis SET NX PX + token-checked PEXPIRE renewal lives in `redis.ts`.
 *
 * Acquire wait defaults to the Fluid Compute duration ceiling (800s) so
 * a confirm/choice that already holds the lock for a long host turn is
 * not 500'd by a concurrent chat after 10s. Tests pass a short `waitMs`.
 */
import { withKeyLock } from "./with-key-lock.js";

export const CONVERSATION_LOCK_TTL_MS = 60_000;

/** Wait to acquire at least as long as the host Fluid maxDuration ceiling. */
export const CONVERSATION_LOCK_WAIT_MS = 800_000;

export function conversationLockRedisKey(conversationId: string): string {
  return `lock:conversation:${conversationId}`;
}

export function conversationLockRenewEveryMs(ttlMs: number): number {
  return Math.max(1, Math.floor(ttlMs / 3));
}

export interface ConversationLock {
  withLock<T>(conversationId: string, work: () => Promise<T>): Promise<T>;
}

export function createMemoryConversationLock(): ConversationLock {
  const tails = new Map<string, Promise<void>>();
  return {
    withLock(conversationId, work) {
      return withKeyLock(tails, conversationLockRedisKey(conversationId), work);
    },
  };
}
