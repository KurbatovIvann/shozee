/**
 * `createIdempotencyHook` — the fnd-T15 idempotency protocol (core.md §5).
 *
 * Reservations live in `idempotency_keys`, unique on
 * `(principal key, scope key, action, key)`: both the accountable principal
 * and the tenant scope are part of the identity, so one staff member can
 * never replay another's stored response and a system service cannot
 * collide across companies.
 *
 * Flow: `reserve` INSERTs `in_progress` in its own short transaction (the
 * pipeline calls it before the handler transaction opens). On a unique-key
 * hit: `completed` + same request hash → replay the stored snapshot;
 * different hash → `IdempotencyConflictError`; a live `in_progress` lease →
 * `ConcurrentRetryError`; `failed` or an expired lease → conditional
 * takeover keyed on the observed `attempt_id` and current
 * status/lease/retention eligibility, so exactly one retry wins and a
 * stale snapshot cannot reopen a completed attempt. A lost CAS reloads
 * and returns replay, conflict, or retry. `finalize` flips the row to
 * `completed` with the response snapshot **inside the handler
 * transaction** — snapshot and effects commit atomically. `markFailed`
 * runs in its own transaction after rollback.
 *
 * The lease is the action timeout plus a bounded safety margin: the
 * whole-pipeline deadline (core.md §4) bounds every handler, so an attempt
 * that outlives its lease is dead by construction and no mid-flight renewal
 * is needed. Keys expire after 48 h; the worker loop (fnd-T27) schedules
 * `cleanupExpiredIdempotencyKeys` — core exposes functions, never loops.
 *
 * `probe` is the read-only lookup the confirmation gate uses (fnd-T20):
 * completed rows replay, a live lease is `ConcurrentRetryError`, and a
 * failed/stale row with an unexpired persisted grant resumes. `reserve`
 * persists a consumed confirmation grant on the row so a crash after
 * reservation can resume without reusing the raw token.
 */
import { randomUUID } from "node:crypto";

import { idempotencyKeys, type Database } from "@showzy/db";
import { and, eq, lte, or } from "drizzle-orm";

import {
  ConcurrentRetryError,
  CoreInvariantError,
  IdempotencyConflictError,
} from "../../errors/index.js";
import { canonicalJsonSha256OfUnknown } from "../audit/canonical-json.js";
import type {
  ConfirmationGrant,
  IdempotencyHook,
  IdempotencyProbeResult,
  IdempotencyReserveResult,
  PipelineHookEnv,
} from "../pipeline/types.js";
import { principalKeyFor, requireIdempotencyKey, scopeKeyFor } from "./keys.js";

/** Keys expire 48 h after creation (core.md §5); replay beyond re-executes. */
export const IDEMPOTENCY_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Added to the action timeout to form the lease (core.md §5 "the action
 * timeout plus a bounded safety margin"): generous enough to absorb clock
 * skew and post-handler commit time, small enough that a crashed submit is
 * retryable quickly.
 */
export const IDEMPOTENCY_LEASE_MARGIN_MS = 15_000;

export interface IdempotencyHookDeps {
  readonly db: Database;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Test seam: awaited after a reclaim decision and before the
   * eligibility-fenced UPDATE, so tests can interleave a concurrent
   * finalize without timing sleeps.
   */
  readonly beforeTakeover?: () => Promise<void>;
}

/**
 * Brand distinguishing this hook's reservations from any other object the
 * pipeline could hand back — `finalize`/`markFailed` verify it instead of
 * blindly casting.
 */
const RESERVATION_BRAND = Symbol("idempotency-reservation");

/** The opaque reservation handed back to `finalize`/`markFailed`. */
interface IdempotencyReservation {
  readonly [RESERVATION_BRAND]: true;
  readonly principalKey: string;
  readonly scopeKey: string;
  readonly action: string;
  readonly key: string;
  readonly attemptId: string;
  readonly leaseMs: number;
}

function requireReservation(reservation: unknown): IdempotencyReservation {
  if (
    typeof reservation !== "object" ||
    reservation === null ||
    !(RESERVATION_BRAND in reservation)
  ) {
    throw new CoreInvariantError(
      "idempotency finalize/markFailed received a reservation this hook did not issue — pipeline composition bug",
    );
  }
  return reservation as IdempotencyReservation;
}

export function createIdempotencyHook(
  deps: IdempotencyHookDeps,
): IdempotencyHook {
  const now = deps.now ?? Date.now;
  const beforeTakeover = deps.beforeTakeover;

  return {
    async probe(env) {
      const key = requireIdempotencyKey(env);
      const principalKey = principalKeyFor(env);
      const scopeKey = scopeKeyFor(env, principalKey);
      const requestHash = requestHashOf(env, principalKey, scopeKey);
      const [existing] = await deps.db
        .select()
        .from(idempotencyKeys)
        .where(
          pkWhere({ principalKey, scopeKey, action: env.contract.name, key }),
        );
      if (existing === undefined) {
        return { kind: "fresh" };
      }
      return interpretProbeRow(existing, requestHash, now());
    },

    async reserve(env) {
      const key = requireIdempotencyKey(env);
      const principalKey = principalKeyFor(env);
      const scopeKey = scopeKeyFor(env, principalKey);
      const action = env.contract.name;
      const requestHash = requestHashOf(env, principalKey, scopeKey);
      const leaseMs = env.contract.timeout + IDEMPOTENCY_LEASE_MARGIN_MS;
      const identity = { principalKey, scopeKey, action, key } as const;
      const grant = env.confirmationGrant;

      // Two rounds cover the rare row-vanished race (retention cleanup
      // deleting between our INSERT conflict and SELECT); everything else
      // resolves in one.
      for (let round = 0; round < 2; round += 1) {
        const attemptId = randomUUID();
        const nowMs = now();
        const inserted = await deps.db
          .insert(idempotencyKeys)
          .values({
            ...identity,
            companyId: env.authorization.companyId,
            requestHash,
            status: "in_progress",
            attemptId,
            leaseExpiresAt: new Date(nowMs + leaseMs),
            expiresAt: new Date(nowMs + IDEMPOTENCY_RETENTION_MS),
            ...grantColumns(grant),
          })
          .onConflictDoNothing()
          .returning({ attemptId: idempotencyKeys.attemptId });
        if (inserted.length > 0) {
          return execute({ ...identity, attemptId, leaseMs });
        }

        const [existing] = await deps.db
          .select()
          .from(idempotencyKeys)
          .where(pkWhere(identity));
        if (existing === undefined) {
          continue;
        }

        const nowAfterRead = now();

        // Retention passed but cleanup has not collected the row yet: §5
        // says replay after expiry re-executes, so reuse the slot as if it
        // were fresh (new hash, new retention window, no stale grant).
        if (existing.expiresAt.getTime() <= nowAfterRead) {
          return await takeover(deps.db, {
            identity,
            observedAttemptId: existing.attemptId,
            requestHash,
            leaseMs,
            nowMs: nowAfterRead,
            now,
            grant,
            ...(beforeTakeover === undefined ? {} : { beforeTakeover }),
            reset: {
              requestHash,
              expiresAt: new Date(nowAfterRead + IDEMPOTENCY_RETENTION_MS),
              confirmationChallengeId: null,
              confirmedAt: null,
              confirmationExpiresAt: null,
            },
          });
        }

        if (existing.requestHash !== requestHash) {
          // §5 spells this out for `completed`; a divergent payload on a
          // live or failed row is the same caller bug (one key = one
          // logical submit), and taking it over would corrupt the record.
          throw new IdempotencyConflictError(undefined, {
            internalMessage: `idempotency key reuse with a different payload on "${action}" (status ${existing.status})`,
          });
        }

        switch (existing.status) {
          case "completed":
            return { kind: "replay", response: existing.response };
          case "failed":
            return await takeover(deps.db, {
              identity,
              observedAttemptId: existing.attemptId,
              requestHash,
              leaseMs,
              nowMs: nowAfterRead,
              now,
              grant,
              ...(beforeTakeover === undefined ? {} : { beforeTakeover }),
            });
          case "in_progress": {
            if (existing.leaseExpiresAt.getTime() > nowAfterRead) {
              throw new ConcurrentRetryError(
                retryAfterSec(existing.leaseExpiresAt.getTime() - nowAfterRead),
                undefined,
                {
                  internalMessage: `a live attempt ${existing.attemptId} holds the lease on "${action}"`,
                },
              );
            }
            // Crashed/stale attempt: the lease expired without finalize or
            // markFailed. Conditional takeover — exactly one caller wins.
            return await takeover(deps.db, {
              identity,
              observedAttemptId: existing.attemptId,
              requestHash,
              leaseMs,
              nowMs: nowAfterRead,
              now,
              grant,
              ...(beforeTakeover === undefined ? {} : { beforeTakeover }),
            });
          }
          default:
            throw new CoreInvariantError(
              `idempotency row for "${action}" has unknown status "${existing.status}"`,
            );
        }
      }
      throw new ConcurrentRetryError(1, undefined, {
        internalMessage: `idempotency reservation on "${action}" kept vanishing between statements — cleanup race`,
      });
    },

    async finalize({ tx, reservation, output }) {
      const r = requireReservation(reservation);
      const updated = await tx
        .update(idempotencyKeys)
        .set({ status: "completed", response: output })
        .where(
          and(
            pkWhere(r),
            eq(idempotencyKeys.attemptId, r.attemptId),
            eq(idempotencyKeys.status, "in_progress"),
          ),
        )
        .returning({ key: idempotencyKeys.key });
      if (updated.length === 0) {
        // A concurrent retry presumed this attempt dead and took the lease
        // over. Committing would double-execute the effects — throw so the
        // whole handler transaction rolls back.
        throw new ConcurrentRetryError(retryAfterSec(r.leaseMs), undefined, {
          internalMessage: `attempt ${r.attemptId} of "${r.action}" lost its lease before finalize`,
        });
      }
    },

    async markFailed({ reservation }) {
      const r = requireReservation(reservation);
      // A separate short transaction (single statement) after rollback. Zero
      // rows is fine: a takeover already owns the key.
      await deps.db
        .update(idempotencyKeys)
        .set({ status: "failed" })
        .where(
          and(
            pkWhere(r),
            eq(idempotencyKeys.attemptId, r.attemptId),
            eq(idempotencyKeys.status, "in_progress"),
          ),
        );
    },
  };
}

/**
 * Deletes keys past their 48-h retention (core.md §5). The worker loop
 * (fnd-T27) schedules this; returns the number of removed rows for its
 * job log line.
 */
export async function cleanupExpiredIdempotencyKeys(
  db: Pick<Database, "delete">,
  now: () => number = Date.now,
): Promise<number> {
  const removed = await db
    .delete(idempotencyKeys)
    .where(lte(idempotencyKeys.expiresAt, new Date(now())))
    .returning({ key: idempotencyKeys.key });
  return removed.length;
}

interface RowIdentity {
  readonly principalKey: string;
  readonly scopeKey: string;
  readonly action: string;
  readonly key: string;
}

function pkWhere(identity: RowIdentity): ReturnType<typeof and> {
  return and(
    eq(idempotencyKeys.principalKey, identity.principalKey),
    eq(idempotencyKeys.scopeKey, identity.scopeKey),
    eq(idempotencyKeys.action, identity.action),
    eq(idempotencyKeys.key, identity.key),
  );
}

function execute(
  reservation: Omit<IdempotencyReservation, typeof RESERVATION_BRAND>,
): IdempotencyReserveResult {
  return {
    kind: "execute",
    reservation: { ...reservation, [RESERVATION_BRAND]: true },
  };
}

/**
 * Conditional takeover of a failed/stale/expired reservation. The UPDATE
 * is fenced on the observed `attempt_id` **and** current eligibility
 * (retention passed, `failed`, or `in_progress` with an expired lease)
 * so a stale snapshot cannot reopen a completed attempt (SHO-434). A lost
 * CAS reloads and returns replay, conflict, or retry.
 */
async function takeover(
  db: Database,
  options: {
    readonly identity: RowIdentity;
    readonly observedAttemptId: string;
    readonly requestHash: string;
    readonly leaseMs: number;
    readonly nowMs: number;
    readonly now: () => number;
    readonly grant: ConfirmationGrant | undefined;
    readonly beforeTakeover?: () => Promise<void>;
    /** Set when reusing a row whose retention has passed. */
    readonly reset?: {
      readonly requestHash: string;
      readonly expiresAt: Date;
      readonly confirmationChallengeId: null;
      readonly confirmedAt: null;
      readonly confirmationExpiresAt: null;
    };
  },
): Promise<IdempotencyReserveResult> {
  const attemptId = randomUUID();
  await options.beforeTakeover?.();
  const updated = await db
    .update(idempotencyKeys)
    .set({
      status: "in_progress",
      attemptId,
      leaseExpiresAt: new Date(options.nowMs + options.leaseMs),
      response: null,
      ...options.reset,
      // Applied after `reset` so a fresh post-retention confirm keeps the
      // newly consumed grant instead of the nulled columns.
      ...grantColumns(options.grant),
    })
    .where(
      and(
        pkWhere(options.identity),
        eq(idempotencyKeys.attemptId, options.observedAttemptId),
        reclaimableWhere(options.nowMs),
      ),
    )
    .returning({ attemptId: idempotencyKeys.attemptId });
  if (updated.length === 0) {
    return await resolveLostTakeover(db, options);
  }
  return execute({ ...options.identity, attemptId, leaseMs: options.leaseMs });
}

/**
 * Eligibility at mutation time: retention has passed (replay re-executes),
 * the attempt failed, or an `in_progress` lease is expired. `completed`
 * inside the retention window is intentionally excluded.
 */
function reclaimableWhere(nowMs: number) {
  const at = new Date(nowMs);
  return or(
    lte(idempotencyKeys.expiresAt, at),
    eq(idempotencyKeys.status, "failed"),
    and(
      eq(idempotencyKeys.status, "in_progress"),
      lte(idempotencyKeys.leaseExpiresAt, at),
    ),
  );
}

async function resolveLostTakeover(
  db: Database,
  options: {
    readonly identity: RowIdentity;
    readonly requestHash: string;
    readonly leaseMs: number;
    readonly now: () => number;
  },
): Promise<IdempotencyReserveResult> {
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(pkWhere(options.identity));
  if (existing === undefined) {
    throw new ConcurrentRetryError(1, undefined, {
      internalMessage: `idempotency reservation on "${options.identity.action}" vanished during takeover — cleanup race`,
    });
  }
  const nowMs = options.now();
  if (existing.requestHash !== options.requestHash) {
    throw new IdempotencyConflictError(undefined, {
      internalMessage: `idempotency key reuse with a different payload on "${options.identity.action}" (status ${existing.status})`,
    });
  }
  if (existing.status === "completed") {
    return { kind: "replay", response: existing.response };
  }
  if (
    existing.status === "in_progress" &&
    existing.leaseExpiresAt.getTime() > nowMs
  ) {
    throw new ConcurrentRetryError(
      retryAfterSec(existing.leaseExpiresAt.getTime() - nowMs),
      undefined,
      {
        internalMessage: `a live attempt ${existing.attemptId} holds the lease on "${options.identity.action}"`,
      },
    );
  }
  throw new ConcurrentRetryError(retryAfterSec(options.leaseMs), undefined, {
    internalMessage: `lost the conditional takeover race on "${options.identity.action}"`,
  });
}

function requestHashOf(
  env: PipelineHookEnv,
  principalKey: string,
  scopeKey: string,
): string {
  return canonicalJsonSha256OfUnknown({
    input: env.input,
    principalKey,
    scopeKey,
  });
}

function grantColumns(grant: ConfirmationGrant | undefined): {
  confirmationChallengeId?: string;
  confirmedAt?: Date;
  confirmationExpiresAt?: Date;
} {
  if (grant === undefined) {
    return {};
  }
  return {
    confirmationChallengeId: grant.challengeId,
    confirmedAt: grant.confirmedAt,
    confirmationExpiresAt: grant.expiresAt,
  };
}

function interpretProbeRow(
  existing: typeof idempotencyKeys.$inferSelect,
  requestHash: string,
  nowMs: number,
): IdempotencyProbeResult {
  if (existing.expiresAt.getTime() <= nowMs) {
    return { kind: "fresh" };
  }
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyConflictError(undefined, {
      internalMessage: `idempotency key reuse with a different payload on "${existing.action}" (status ${existing.status})`,
    });
  }
  switch (existing.status) {
    case "completed":
      return { kind: "replay", response: existing.response };
    case "failed":
    case "in_progress": {
      if (
        existing.status === "in_progress" &&
        existing.leaseExpiresAt.getTime() > nowMs
      ) {
        throw new ConcurrentRetryError(
          retryAfterSec(existing.leaseExpiresAt.getTime() - nowMs),
          undefined,
          {
            internalMessage: `a live attempt ${existing.attemptId} holds the lease on "${existing.action}"`,
          },
        );
      }
      const grant = unexpiredGrant(existing, nowMs);
      return grant === undefined
        ? { kind: "fresh" }
        : { kind: "resume", grant };
    }
    default:
      throw new CoreInvariantError(
        `idempotency row for "${existing.action}" has unknown status "${existing.status}"`,
      );
  }
}

function unexpiredGrant(
  row: typeof idempotencyKeys.$inferSelect,
  nowMs: number,
): ConfirmationGrant | undefined {
  if (
    row.confirmationChallengeId === null ||
    row.confirmedAt === null ||
    row.confirmationExpiresAt === null ||
    row.confirmationExpiresAt.getTime() <= nowMs
  ) {
    return undefined;
  }
  return {
    challengeId: row.confirmationChallengeId,
    confirmedAt: row.confirmedAt,
    expiresAt: row.confirmationExpiresAt,
  };
}

function retryAfterSec(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
