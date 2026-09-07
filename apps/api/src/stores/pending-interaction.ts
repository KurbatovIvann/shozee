/**
 * Staff-assistant pending-interaction store (ADR-0035 / SHO-516).
 *
 * Confirmation and choice share one CAS: `open → claimed → completed`.
 * Never GETDEL — that stays core's confirmation challenge. In-memory CAS
 * uses the same per-key mutex as OTP/auth rate-limit stores. Cross-process
 * atomicity is Redis Lua in `redis.ts`.
 *
 * Keys are `pending:{kind}:{id}`. Canonical input is server-authoritative
 * and must not be logged at info.
 */
import {
  bindsMatch,
  choiceRecordToPending,
  parsePendingInteractionRecord,
  pendingBindOf,
  pendingClaimedResolutionOf,
  pendingIdOf,
  pendingKindOf,
  pendingRecordTtlMs,
  pendingRedisKey,
  pendingToChoiceRecord,
  serializePendingInteractionRecord,
  type ChoiceBind,
  type ChoicePendingRecord,
  type ChoiceRecord,
  type ConfirmationPendingRecord,
  type ConfirmationResumeResult,
  type PendingInteractionKind,
  type PendingInteractionRecord,
} from "@showzy/ai";

import { CoreInvariantError } from "@showzy/core/errors";

import type {
  ChoiceClaimDecision,
  ChoiceCompleteDecision,
  ChoicePeekDecision,
  StaffAssistantChoiceStore,
} from "./choice.js";
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

export interface StaffAssistantPendingInteractionStore {
  open(record: PendingInteractionRecord): Promise<boolean>;
  claim(input: {
    readonly kind: PendingInteractionKind;
    readonly id: string;
    readonly bind: ChoiceBind;
    readonly resolution: string;
  }): Promise<PendingClaimDecision>;
  complete(input: {
    readonly kind: PendingInteractionKind;
    readonly id: string;
    readonly bind: ChoiceBind;
    readonly resolution: string;
    readonly resumeResult?: ConfirmationResumeResult;
  }): Promise<PendingCompleteDecision>;
  get(input: {
    readonly kind: PendingInteractionKind;
    readonly id: string;
  }): Promise<PendingInteractionRecord | null>;
  peek(input: {
    readonly kind: PendingInteractionKind;
    readonly id: string;
    readonly bind: ChoiceBind;
  }): Promise<ChoicePeekDecision>;
  unsafeReplaceCanonicalInput?(input: {
    readonly kind: PendingInteractionKind;
    readonly id: string;
    readonly canonicalInput: unknown;
  }): Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

const CONFIRMATION_RESOLUTION = "confirmed";

function isLiveChoiceRecord(
  record: PendingInteractionRecord,
): record is ChoicePendingRecord {
  return pendingKindOf(record) === "choice";
}

function isValidResolution(
  record: PendingInteractionRecord,
  resolution: string,
): boolean {
  if (pendingKindOf(record) === "confirmation") {
    return resolution === CONFIRMATION_RESOLUTION;
  }
  if (!isLiveChoiceRecord(record)) {
    return false;
  }
  return record.optionMap[resolution] !== undefined;
}

function withClaimedResolution(
  record: PendingInteractionRecord,
  resolution: string,
): PendingInteractionRecord {
  if (record.kind === "confirmation") {
    return {
      ...record,
      status: "claimed",
      claimedResolution: "confirmed",
    };
  }
  return {
    ...record,
    status: "claimed",
    claimedOptionId: resolution,
  };
}

function withCompletedResume(
  record: PendingInteractionRecord,
  resumeResult: ConfirmationResumeResult | undefined,
): PendingInteractionRecord {
  if (record.kind === "confirmation") {
    return {
      ...record,
      status: "completed",
      ...(resumeResult !== undefined ? { resumeResult } : {}),
    };
  }
  return {
    ...record,
    status: "completed",
  };
}

export function createMemoryPendingInteractionStore(options?: {
  readonly now?: () => number;
  readonly ttlMs?: number;
}): StaffAssistantPendingInteractionStore {
  const now = options?.now ?? Date.now;
  const entries = new Map<string, MemoryEntry>();
  const tails = new Map<string, Promise<void>>();

  function readLive(key: string): PendingInteractionRecord | undefined {
    const entry = entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAtMs <= now()) {
      entries.delete(key);
      return undefined;
    }
    return parsePendingInteractionRecord(entry.value);
  }

  function write(
    key: string,
    record: PendingInteractionRecord,
    expiresAtMs: number,
  ): void {
    entries.set(key, {
      value: serializePendingInteractionRecord(record),
      expiresAtMs,
    });
  }

  return {
    open(record) {
      const kind = pendingKindOf(record);
      const id = pendingIdOf(record);
      const key = pendingRedisKey(kind, id);
      return withKeyLock(tails, key, () => {
        if (readLive(key) !== undefined) {
          return Promise.resolve(false);
        }
        write(
          key,
          { ...record, status: "open" },
          now() + (options?.ttlMs ?? pendingRecordTtlMs(kind)),
        );
        return Promise.resolve(true);
      });
    },

    claim(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(tails, key, (): Promise<PendingClaimDecision> => {
        const existing = entries.get(key);
        if (existing === undefined || existing.expiresAtMs <= now()) {
          entries.delete(key);
          return Promise.resolve({ kind: "expired" as const });
        }
        const record = parsePendingInteractionRecord(existing.value);
        if (record === undefined) {
          entries.delete(key);
          return Promise.resolve({ kind: "expired" as const });
        }
        if (!bindsMatch(pendingBindOf(record), input.bind)) {
          return Promise.resolve({ kind: "forbidden" as const });
        }
        if (!isValidResolution(record, input.resolution)) {
          return Promise.resolve({ kind: "invalid_option" as const });
        }
        if (record.status === "open") {
          const claimed = withClaimedResolution(record, input.resolution);
          write(key, claimed, existing.expiresAtMs);
          return Promise.resolve({ kind: "claimed" as const, record: claimed });
        }
        if (pendingClaimedResolutionOf(record) === input.resolution) {
          return Promise.resolve({ kind: "replay" as const, record });
        }
        return Promise.resolve({ kind: "conflict" as const });
      });
    },

    complete(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(tails, key, (): Promise<PendingCompleteDecision> => {
        const existing = entries.get(key);
        if (existing === undefined || existing.expiresAtMs <= now()) {
          entries.delete(key);
          return Promise.resolve({ kind: "expired" as const });
        }
        const record = parsePendingInteractionRecord(existing.value);
        if (record === undefined) {
          entries.delete(key);
          return Promise.resolve({ kind: "expired" as const });
        }
        if (!bindsMatch(pendingBindOf(record), input.bind)) {
          return Promise.resolve({ kind: "forbidden" as const });
        }
        if (record.status === "completed") {
          if (pendingClaimedResolutionOf(record) === input.resolution) {
            return Promise.resolve({ kind: "replay" as const, record });
          }
          return Promise.resolve({ kind: "conflict" as const });
        }
        if (
          record.status !== "claimed" ||
          pendingClaimedResolutionOf(record) !== input.resolution
        ) {
          return Promise.resolve({ kind: "conflict" as const });
        }
        const completed = withCompletedResume(record, input.resumeResult);
        write(key, completed, existing.expiresAtMs);
        return Promise.resolve({
          kind: "completed" as const,
          record: completed,
        });
      });
    },

    get(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(tails, key, () => {
        const record = readLive(key);
        return Promise.resolve(record ?? null);
      });
    },

    peek(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(tails, key, (): Promise<ChoicePeekDecision> => {
        const record = readLive(key);
        if (record === undefined) {
          return Promise.resolve({ kind: "expired" as const });
        }
        if (!bindsMatch(pendingBindOf(record), input.bind)) {
          return Promise.resolve({ kind: "forbidden" as const });
        }
        if (!isLiveChoiceRecord(record)) {
          return Promise.resolve({ kind: "expired" as const });
        }
        return Promise.resolve({
          kind: "found" as const,
          record: pendingToChoiceRecord(record),
        });
      });
    },

    unsafeReplaceCanonicalInput(input) {
      const key = pendingRedisKey(input.kind, input.id);
      return withKeyLock(tails, key, () => {
        const existing = entries.get(key);
        if (existing === undefined || existing.expiresAtMs <= now()) {
          return Promise.resolve();
        }
        const record = parsePendingInteractionRecord(existing.value);
        if (record === undefined) {
          return Promise.resolve();
        }
        write(
          key,
          { ...record, canonicalInput: input.canonicalInput },
          existing.expiresAtMs,
        );
        return Promise.resolve();
      });
    },
  };
}

function asChoiceRecord(record: PendingInteractionRecord): ChoiceRecord {
  if (!isLiveChoiceRecord(record)) {
    throw new CoreInvariantError(
      "pending choice façade received a confirmation record",
    );
  }
  return pendingToChoiceRecord(record);
}

function toChoiceClaim(decision: PendingClaimDecision): ChoiceClaimDecision {
  if (decision.kind === "claimed" || decision.kind === "replay") {
    return { kind: decision.kind, record: asChoiceRecord(decision.record) };
  }
  return decision;
}

function toChoiceComplete(
  decision: PendingCompleteDecision,
): ChoiceCompleteDecision {
  if (decision.kind === "completed" || decision.kind === "replay") {
    return { kind: decision.kind, record: asChoiceRecord(decision.record) };
  }
  return decision;
}

const pendingBacking = new WeakMap<
  StaffAssistantChoiceStore,
  StaffAssistantPendingInteractionStore
>();

export function bindPendingStoreBacking(
  choice: StaffAssistantChoiceStore,
  pending: StaffAssistantPendingInteractionStore,
): void {
  pendingBacking.set(choice, pending);
}

export function pendingStoreBacking(
  choice: StaffAssistantChoiceStore | undefined,
): StaffAssistantPendingInteractionStore | undefined {
  if (choice === undefined) {
    return undefined;
  }
  return pendingBacking.get(choice);
}

export function createChoiceStoreFromPending(
  pending: StaffAssistantPendingInteractionStore,
): StaffAssistantChoiceStore {
  return {
    open(record) {
      return pending.open(choiceRecordToPending(record));
    },
    async claim(input) {
      return toChoiceClaim(
        await pending.claim({
          kind: "choice",
          id: input.choiceId,
          bind: input.bind,
          resolution: input.optionId,
        }),
      );
    },
    peek(input) {
      return pending.peek({
        kind: "choice",
        id: input.choiceId,
        bind: input.bind,
      });
    },
    async complete(input) {
      return toChoiceComplete(
        await pending.complete({
          kind: "choice",
          id: input.choiceId,
          bind: input.bind,
          resolution: input.optionId,
        }),
      );
    },
  };
}

export function isConfirmationPendingRecord(
  record: PendingInteractionRecord,
): record is ConfirmationPendingRecord {
  return record.kind === "confirmation";
}
