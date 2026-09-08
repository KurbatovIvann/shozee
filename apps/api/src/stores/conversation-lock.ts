/**
 * Per-conversation mutex shared by host chat, replace, abandon, and
 * resume (SHO-522). CAS on one pending record is not enough.
 *
 * In-memory uses the same per-key mutex as choice/OTP stores. Redis
 * SET NX PX lives in `redis.ts`.
 */
import { withKeyLock } from "./with-key-lock.js";

export const CONVERSATION_LOCK_TTL_MS = 60_000;

export function conversationLockRedisKey(conversationId: string): string {
  return `lock:conversation:${conversationId}`;
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
