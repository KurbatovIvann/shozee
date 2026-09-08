/**
 * Staff-assistant pending-interaction store (SHO-522 / ADR-0035).
 *
 * Generalizes the choice CAS store: choice and confirmation share one
 * conversation-indexed record. Cross-process atomicity is Redis Lua in
 * `redis.ts`. Never GETDEL — that stays confirmation's core primitive.
 */
import {
  bindsMatch,
  parseConversationPendingIndex,
  parsePendingRecord,
  pendingConversationIndexKey,
  pendingRecordBind,
  pendingRedisKey,
  pendingTtlMs,
  serializePendingRecord,
  conversationPendingIndexPayload,
  type PendingBind,
  type PendingInteractionRecord,
  type PendingKind,
} from "@showzy/ai";

import { withKeyLock } from "./with-key-lock.js";

export type PendingClaimDecision =
  | { readonly kind: "claimed"; readonly record: PendingInteractionRecord }
  | { readonly kind: "replay"; readonly record: PendingInteractionRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_option" };

export type PendingCompleteDecision =
  | { readonly kind: "completed"; readonly record: PendingInteractionRecord }
  | { readonly kind: "replay"; readonly record: PendingInteractionRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" };

export type PendingAbandonDecision =
  | { readonly kind: "abandoned"; readonly record: PendingInteractionRecord }
  | { readonly kind: "replay"; readonly record: PendingInteractionRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" };

export type PendingReplaceDecision =
  | {
      readonly kind: "replaced";
      readonly previous: PendingInteractionRecord;
      readonly record: PendingInteractionRecord;
    }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" };

export type PendingPeekDecision =
  | { readonly kind: "found"; readonly record: PendingInteractionRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" };

export type PendingPeekOpenDecision =
  | { readonly kind: "found"; readonly record: PendingInteractionRecord }
  | { readonly kind: "empty" };

export interface StaffAssistantPendingStore {
  open(record: PendingInteractionRecord): Promise<boolean>;
  claim(input: {
    readonly id: string;
    readonly kind: PendingKind;
    readonly bind: PendingBind;
    readonly optionId?: string;
  }): Promise<PendingClaimDecision>;
  peek(input: {
    readonly id: string;
    readonly kind?: PendingKind;
    readonly bind: PendingBind;
  }): Promise<PendingPeekDecision>;
  peekOpen(input: {
    readonly conversationId: string;
    readonly bind: PendingBind;
  }): Promise<PendingPeekOpenDecision>;
  complete(input: {
    readonly id: string;
    readonly kind: PendingKind;
    readonly bind: PendingBind;
    readonly optionId?: string;
  }): Promise<PendingCompleteDecision>;
  abandon(input: {
    readonly id: string;
    readonly bind: PendingBind;
    readonly expectedVersion: number;
  }): Promise<PendingAbandonDecision>;
  replace(input: {
    readonly id: string;
    readonly bind: PendingBind;
    readonly expectedVersion: number;
    readonly next: PendingInteractionRecord;
  }): Promise<PendingReplaceDecision>;
}

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

function liveStatuses(record: PendingInteractionRecord): boolean {
  return record.status === "open" || record.status === "claimed";
}

export function createMemoryPendingStore(options?: {
  readonly now?: () => number;
}): StaffAssistantPendingStore {
  const now = options?.now ?? Date.now;
  const entries = new Map<string, MemoryEntry>();
  const tails = new Map<string, Promise<void>>();

  function ttlMsFor(record: PendingInteractionRecord): number {
    return pendingTtlMs(record.kind);
  }

  function readLive(key: string): PendingInteractionRecord | undefined {
    const entry = entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAtMs <= now()) {
      entries.delete(key);
      return undefined;
    }
    return parsePendingRecord(entry.value);
  }

  function write(
    key: string,
    record: PendingInteractionRecord,
    expiresAtMs: number,
  ): void {
    entries.set(key, {
      value: serializePendingRecord(record),
      expiresAtMs,
    });
  }

  function findById(id: string):
    | {
        readonly key: string;
        readonly record: PendingInteractionRecord;
        readonly expiresAtMs: number;
      }
    | undefined {
    for (const kind of ["choice", "confirmation"] as const) {
      const key = pendingRedisKey(kind, id);
      const entry = entries.get(key);
      if (entry === undefined || entry.expiresAtMs <= now()) {
        continue;
      }
      const record = parsePendingRecord(entry.value);
      if (record !== undefined) {
        return { key, record, expiresAtMs: entry.expiresAtMs };
      }
    }
    return undefined;
  }

  function conversationMutex(conversationId: string): string {
    return pendingConversationIndexKey(conversationId);
  }

  function indexKey(conversationId: string): string {
    return pendingConversationIndexKey(conversationId);
  }

  function writeIndex(
    conversationId: string,
    record: PendingInteractionRecord,
    expiresAtMs: number,
  ): void {
    entries.set(indexKey(conversationId), {
      value: conversationPendingIndexPayload(record),
      expiresAtMs,
    });
  }

  function clearIndexIfMatches(conversationId: string, id: string): void {
    const key = indexKey(conversationId);
    const entry = entries.get(key);
    if (entry === undefined) {
      return;
    }
    const parsed = parseConversationPendingIndex(entry.value);
    if (parsed?.id === id) {
      entries.delete(key);
    }
  }

  function readIndexedLive(
    conversationId: string,
  ): PendingInteractionRecord | undefined {
    const raw = entries.get(indexKey(conversationId));
    if (raw === undefined || raw.expiresAtMs <= now()) {
      entries.delete(indexKey(conversationId));
      return undefined;
    }
    const parsed = parseConversationPendingIndex(raw.value);
    if (parsed === undefined) {
      entries.delete(indexKey(conversationId));
      return undefined;
    }
    const record = readLive(pendingRedisKey(parsed.kind, parsed.id));
    if (record === undefined || !liveStatuses(record)) {
      entries.delete(indexKey(conversationId));
      return undefined;
    }
    return record;
  }

  return {
    open(record) {
      const conversationId = record.conversationId;
      return withKeyLock(tails, conversationMutex(conversationId), () => {
        if (readIndexedLive(conversationId) !== undefined) {
          return Promise.resolve(false);
        }
        const key = pendingRedisKey(record.kind, record.id);
        if (readLive(key) !== undefined) {
          return Promise.resolve(false);
        }
        const expiresAtMs = now() + ttlMsFor(record);
        const opened: PendingInteractionRecord = {
          ...record,
          status: "open",
          version: record.version,
        };
        write(key, opened, expiresAtMs);
        writeIndex(conversationId, opened, expiresAtMs);
        return Promise.resolve(true);
      });
    },

    claim(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(
        tails,
        conversationMutex(input.bind.conversationId),
        (): Promise<PendingClaimDecision> => {
          const existing = entries.get(key);
          if (existing === undefined || existing.expiresAtMs <= now()) {
            entries.delete(key);
            return Promise.resolve({ kind: "expired" as const });
          }
          const record = parsePendingRecord(existing.value);
          if (record === undefined) {
            entries.delete(key);
            return Promise.resolve({ kind: "expired" as const });
          }
          if (!bindsMatch(pendingRecordBind(record), input.bind)) {
            return Promise.resolve({ kind: "forbidden" as const });
          }
          if (record.status === "abandoned" || record.status === "superseded") {
            return Promise.resolve({ kind: "expired" as const });
          }
          if (record.kind === "choice") {
            if (input.optionId === undefined) {
              return Promise.resolve({ kind: "invalid_option" as const });
            }
            if (record.optionMap[input.optionId] === undefined) {
              return Promise.resolve({ kind: "invalid_option" as const });
            }
            if (record.status === "open") {
              const claimed: PendingInteractionRecord = {
                ...record,
                status: "claimed",
                claimedOptionId: input.optionId,
              };
              write(key, claimed, existing.expiresAtMs);
              return Promise.resolve({
                kind: "claimed" as const,
                record: claimed,
              });
            }
            if (record.claimedOptionId === input.optionId) {
              return Promise.resolve({ kind: "replay" as const, record });
            }
            return Promise.resolve({ kind: "conflict" as const });
          }
          if (record.status === "open") {
            const claimed: PendingInteractionRecord = {
              ...record,
              status: "claimed",
            };
            write(key, claimed, existing.expiresAtMs);
            return Promise.resolve({
              kind: "claimed" as const,
              record: claimed,
            });
          }
          return Promise.resolve({ kind: "replay" as const, record });
        },
      );
    },

    peek(input) {
      return withKeyLock(
        tails,
        conversationMutex(input.bind.conversationId),
        (): Promise<PendingPeekDecision> => {
          const found =
            input.kind === undefined
              ? findById(input.id)
              : (() => {
                  const key = pendingRedisKey(input.kind, input.id);
                  const record = readLive(key);
                  const entry = entries.get(key);
                  if (record === undefined || entry === undefined) {
                    return undefined;
                  }
                  return { key, record, expiresAtMs: entry.expiresAtMs };
                })();
          if (found === undefined) {
            return Promise.resolve({ kind: "expired" as const });
          }
          if (!bindsMatch(pendingRecordBind(found.record), input.bind)) {
            return Promise.resolve({ kind: "forbidden" as const });
          }
          return Promise.resolve({
            kind: "found" as const,
            record: found.record,
          });
        },
      );
    },

    peekOpen(input) {
      return withKeyLock(
        tails,
        conversationMutex(input.conversationId),
        (): Promise<PendingPeekOpenDecision> => {
          const record = readIndexedLive(input.conversationId);
          if (record === undefined) {
            return Promise.resolve({ kind: "empty" as const });
          }
          if (!bindsMatch(pendingRecordBind(record), input.bind)) {
            return Promise.resolve({ kind: "empty" as const });
          }
          return Promise.resolve({ kind: "found" as const, record });
        },
      );
    },

    complete(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(
        tails,
        conversationMutex(input.bind.conversationId),
        (): Promise<PendingCompleteDecision> => {
          const existing = entries.get(key);
          if (existing === undefined || existing.expiresAtMs <= now()) {
            entries.delete(key);
            return Promise.resolve({ kind: "expired" as const });
          }
          const record = parsePendingRecord(existing.value);
          if (record === undefined) {
            entries.delete(key);
            return Promise.resolve({ kind: "expired" as const });
          }
          if (!bindsMatch(pendingRecordBind(record), input.bind)) {
            return Promise.resolve({ kind: "forbidden" as const });
          }
          if (record.status === "completed") {
            if (record.kind === "choice") {
              if (record.claimedOptionId === input.optionId) {
                return Promise.resolve({ kind: "replay" as const, record });
              }
              return Promise.resolve({ kind: "conflict" as const });
            }
            return Promise.resolve({ kind: "replay" as const, record });
          }
          if (record.status !== "claimed") {
            return Promise.resolve({ kind: "conflict" as const });
          }
          if (
            record.kind === "choice" &&
            record.claimedOptionId !== input.optionId
          ) {
            return Promise.resolve({ kind: "conflict" as const });
          }
          const completed: PendingInteractionRecord = {
            ...record,
            status: "completed",
          };
          write(key, completed, existing.expiresAtMs);
          clearIndexIfMatches(record.conversationId, record.id);
          return Promise.resolve({
            kind: "completed" as const,
            record: completed,
          });
        },
      );
    },

    abandon(input) {
      return withKeyLock(
        tails,
        conversationMutex(input.bind.conversationId),
        (): Promise<PendingAbandonDecision> => {
          const found = findById(input.id);
          if (found === undefined) {
            return Promise.resolve({ kind: "expired" as const });
          }
          const { key, record, expiresAtMs } = found;
          if (!bindsMatch(pendingRecordBind(record), input.bind)) {
            return Promise.resolve({ kind: "forbidden" as const });
          }
          if (record.version !== input.expectedVersion) {
            return Promise.resolve({ kind: "expired" as const });
          }
          if (record.status === "abandoned") {
            return Promise.resolve({ kind: "replay" as const, record });
          }
          if (record.status !== "open" && record.status !== "claimed") {
            return Promise.resolve({ kind: "expired" as const });
          }
          const abandoned: PendingInteractionRecord = {
            ...record,
            status: "abandoned",
          };
          write(key, abandoned, expiresAtMs);
          clearIndexIfMatches(record.conversationId, record.id);
          return Promise.resolve({
            kind: "abandoned" as const,
            record: abandoned,
          });
        },
      );
    },

    replace(input) {
      return withKeyLock(
        tails,
        conversationMutex(input.bind.conversationId),
        (): Promise<PendingReplaceDecision> => {
          const found = findById(input.id);
          if (found === undefined) {
            return Promise.resolve({ kind: "expired" as const });
          }
          const { key, record, expiresAtMs } = found;
          if (!bindsMatch(pendingRecordBind(record), input.bind)) {
            return Promise.resolve({ kind: "forbidden" as const });
          }
          if (record.version !== input.expectedVersion) {
            return Promise.resolve({ kind: "expired" as const });
          }
          if (record.status !== "open") {
            return Promise.resolve({ kind: "expired" as const });
          }
          const superseded: PendingInteractionRecord = {
            ...record,
            status: "superseded",
          };
          write(key, superseded, expiresAtMs);
          const nextExpires = now() + ttlMsFor(input.next);
          const opened: PendingInteractionRecord = {
            ...input.next,
            status: "open",
          };
          write(pendingRedisKey(opened.kind, opened.id), opened, nextExpires);
          writeIndex(opened.conversationId, opened, nextExpires);
          return Promise.resolve({
            kind: "replaced" as const,
            previous: superseded,
            record: opened,
          });
        },
      );
    },
  };
}
