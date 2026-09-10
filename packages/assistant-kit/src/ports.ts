import type { z } from "zod";

import type { InteractionRegistry, InteractionType } from "./interaction.js";

/**
 * Everything this package needs from the outside, and nothing more.
 *
 * The kit owns no storage. A test supplies a Map and needs no Redis, no
 * Postgres and no model. That is the whole reason these are interfaces:
 * the protocol is verifiable without infrastructure.
 */

/** Compare-and-set key store. Redis in production. */
export interface PauseStore {
  get(key: string): Promise<string | null>;
  /** False when the key already exists — this is the one-open-pause guard. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** False on mismatch — this is the exactly-once claim. */
  compareAndSet(key: string, expected: string, next: string): Promise<boolean>;
  /**
   * False when the key held something else, or nothing.
   *
   * The releasing half of a lease. A plain delete would let a holder whose ttl
   * had already run out remove the lock that someone else has since taken —
   * rare, and exactly the kind of rare that later reads as a mystery.
   */
  deleteIfEquals(key: string, expected: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface DocumentStore {
  read(conversationId: string): Promise<unknown>;
  write(conversationId: string, write: unknown): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  uuid(): string;
}

export interface KitDeps<
  T extends Record<string, InteractionType<z.ZodType, z.ZodType, never>>,
> {
  readonly pauses: PauseStore;
  readonly documents: DocumentStore;
  readonly clock: Clock;
  readonly ids: Ids;
  /** The kinds this deployment accepts. Their ttl travels with them. */
  readonly interactions: InteractionRegistry<T>;
}
