/**
 * Per-user turn limit and Kyiv-day USD budget for the assistant routes
 * (SHO-505). Consumes core `RateLimitStore` and `AiBudgetStore`. Throws
 * `RateLimitError` — no new error code.
 *
 * Budget is reserved (increment-with-cap of `unknownModelTurnUsd`) before
 * the turn bucket is consumed, so a budget 429 does not spend a turn slot.
 *
 * **A reservation belongs to a turn, not to a request (SHO-572).** It is
 * recorded under `aiBudgetHoldKey` — the turn's own identity — so a retry of
 * the same command finds the reservation an earlier attempt took instead of
 * taking a second one, and a request gives back only what it took itself.
 * Since the switch a turn can be retried as often as the phone reconnects, and
 * without that key a run of failed accepts would spend a company's whole day.
 */
import { kyivCalendarDate, secondsUntilKyivMidnight } from "@showzy/ai";
import type { RateLimitDecision, RateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import type { Logger } from "pino";

import {
  AI_BUDGET_TTL_SEC,
  AI_CHAT_TURN_WINDOW_SEC,
  aiBudgetHoldKey,
  aiChatTurnLimitKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  canonicalizeAiBudgetCompanyId,
  type AiBudgetStore,
  type AiBudgetTryAddDecision,
} from "./stores/budget.js";

export type StaffAssistantBudgetDenialReason =
  "turn_limit" | "company_budget" | "global_budget";

export interface StaffAssistantBudgetLimits {
  readonly chatTurnsPerMinutePerUser: number;
  readonly dailyBudgetUsdPerCompany: number;
  readonly dailyBudgetUsdGlobal: number;
  /**
   * Admission reservation, and the accounting fallback for an unpriced
   * model. Greater than 0 — `AI_UNKNOWN_MODEL_TURN_USD` is validated
   * `.positive()`, so admission always runs through the atomic
   * increment-with-cap. Never a disable switch: `0` would put admission
   * back on a read-then-check race.
   */
  readonly unknownModelTurnUsd: number;
}

export const DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS: StaffAssistantBudgetLimits =
  {
    chatTurnsPerMinutePerUser: 20,
    dailyBudgetUsdPerCompany: 5,
    dailyBudgetUsdGlobal: 100,
    unknownModelTurnUsd: 0.1,
  };

/**
 * Which turn a reservation belongs to. Exactly the identity `assistant_turns`
 * is keyed by, so the row and the reservation are two views of one fact rather
 * than two facts that can disagree.
 */
export interface StaffAssistantTurnIdentity {
  readonly kind: "chat" | "answer";
  readonly conversationId: string;
  readonly commandId: string;
}

/** A turn's identity plus the tenant whose counters hold its reservation. */
export interface StaffAssistantBudgetHoldRef extends StaffAssistantTurnIdentity {
  readonly companyId: string;
}

export interface StaffAssistantBudgetHold {
  readonly companyReservedUsd: number;
  readonly globalReservedUsd: number;
  /** Europe/Kyiv `YYYY-MM-DD` captured at admit time. Release uses this. */
  readonly kyivDate: string;
}

/**
 * What one request got from the guard.
 *
 * `created` is the whole of "may this request give the reservation back": true
 * when this request is the one that moved the counters, false when it found a
 * reservation an earlier attempt under the same command had already taken.
 * A request that reserved nothing must never release — the earlier attempt's
 * turn row may be holding it, and giving it back would put the counter below
 * real spend and lift the day's cap.
 */
export interface StaffAssistantBudgetReservation {
  readonly hold: StaffAssistantBudgetHold;
  readonly created: boolean;
}

export function emptyStaffAssistantBudgetHold(
  kyivDate: string,
): StaffAssistantBudgetHold {
  return {
    companyReservedUsd: 0,
    globalReservedUsd: 0,
    kyivDate,
  };
}

export function logStaffAssistantBudgetDenial(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly reason: StaffAssistantBudgetDenialReason;
}): void {
  options.logger.warn(
    {
      request_id: options.requestId,
      company_id: canonicalizeAiBudgetCompanyId(options.companyId),
      reason: options.reason,
    },
    "staff assistant budget denied",
  );
}

export async function enforceStaffAssistantBudget(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly userId: string;
  readonly companyId: string;
  /** The turn this reservation is for. Its identity keys the hold. */
  readonly turn: StaffAssistantTurnIdentity;
  readonly skipTurnLimit: boolean;
  readonly now?: Date;
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<StaffAssistantBudgetReservation> {
  const now = options.now ?? new Date();
  const kyivDate = kyivCalendarDate(now);
  const companyId = canonicalizeAiBudgetCompanyId(options.companyId);
  const ref: StaffAssistantBudgetHoldRef = { ...options.turn, companyId };

  const reservation = await reserveStaffAssistantBudget({
    logger: options.logger,
    requestId: options.requestId,
    ref,
    kyivDate,
    retryAfterSec: secondsUntilKyivMidnight(now),
    budgetStore: options.budgetStore,
    limits: options.limits,
  });

  if (
    options.skipTurnLimit ||
    options.limits.chatTurnsPerMinutePerUser <= 0 ||
    options.rateLimitStore === undefined
  ) {
    return reservation;
  }

  /**
   * The bucket refused, so this request runs nothing. Only a reservation this
   * request took is given back: one it merely found belongs to an earlier
   * attempt under the same command, which may already have a turn row holding
   * it.
   */
  const giveBackOwnReservation = (): Promise<void> =>
    releaseUnusedReservation({
      logger: options.logger,
      requestId: options.requestId,
      ref,
      reservation,
      budgetStore: options.budgetStore,
    });

  let decision: RateLimitDecision;
  try {
    decision = await options.rateLimitStore.consume({
      key: aiChatTurnLimitKey(options.userId),
      limit: options.limits.chatTurnsPerMinutePerUser,
      windowSec: AI_CHAT_TURN_WINDOW_SEC,
    });
  } catch {
    await giveBackOwnReservation();
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      reason: "turn_limit",
    });
    throw new RateLimitError(AI_CHAT_TURN_WINDOW_SEC);
  }
  if (!decision.allowed) {
    await giveBackOwnReservation();
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      reason: "turn_limit",
    });
    throw new RateLimitError(decision.retryAfterSec);
  }
  return reservation;
}

async function reserveStaffAssistantBudget(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly ref: StaffAssistantBudgetHoldRef;
  readonly kyivDate: string;
  readonly retryAfterSec: number;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<StaffAssistantBudgetReservation> {
  const store = options.budgetStore;
  if (store === undefined) {
    return {
      hold: emptyStaffAssistantBudgetHold(options.kyivDate),
      created: false,
    };
  }
  const companyKey = aiCompanyBudgetKey(
    options.ref.companyId,
    options.kyivDate,
  );
  const globalKey = aiGlobalBudgetKey(options.kyivDate);
  const hold = {
    companyReservedUsd: 0,
    globalReservedUsd: 0,
    kyivDate: options.kyivDate,
  };
  const refuse = (reason: StaffAssistantBudgetDenialReason): RateLimitError => {
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.ref.companyId,
      reason,
    });
    return new RateLimitError(options.retryAfterSec);
  };

  try {
    if (options.limits.dailyBudgetUsdPerCompany > 0) {
      hold.companyReservedUsd = await reserveBudgetKey({
        store,
        key: companyKey,
        capUsd: options.limits.dailyBudgetUsdPerCompany,
        reserveUsd: options.limits.unknownModelTurnUsd,
        refuse: () => refuse("company_budget"),
      });
    }
    if (options.limits.dailyBudgetUsdGlobal > 0) {
      hold.globalReservedUsd = await reserveBudgetKey({
        store,
        key: globalKey,
        capUsd: options.limits.dailyBudgetUsdGlobal,
        reserveUsd: options.limits.unknownModelTurnUsd,
        refuse: () => refuse("global_budget"),
      });
    }
  } catch (error: unknown) {
    await subtractHold(options.logger, options.requestId, store, {
      companyKey,
      globalKey,
      hold,
    });
    throw error;
  }

  // The counters move first and the record is written second, and that order is
  // the one that fails closed. The other way round, a retry of the same command
  // arriving in between would find a record whose reservation is not in the
  // counters yet, reserve nothing, and run a turn nobody was charged for — the
  // cap lifted. This way the worst case is that two overlapping retries both
  // reserve for the length of one Redis round trip, and the loser gives its own
  // reservation straight back below. A reservation briefly held twice costs
  // availability and expires with the Kyiv day; one never taken does not.
  let claim;
  try {
    claim = await store.claimHold(
      aiBudgetHoldKey({ ...options.ref, kyivDate: options.kyivDate }),
      encodeHold(hold),
      AI_BUDGET_TTL_SEC,
    );
  } catch {
    // The store is not answering, so whether this turn already holds a
    // reservation is unknown. Refuse, and give back what this request took
    // rather than leaving it to the Kyiv day.
    await subtractHold(options.logger, options.requestId, store, {
      companyKey,
      globalKey,
      hold,
    });
    throw refuse("company_budget");
  }

  if (claim.created) {
    return { hold, created: true };
  }

  const recorded = decodeHold(claim.value, options.kyivDate);
  if (recorded === null) {
    // An earlier attempt recorded something this build cannot read. Its size is
    // unknown, so neither reservation can be given back safely: this one stands
    // as the charge and expires with its Kyiv-day key. The day's cap is reached
    // early, never lifted.
    options.logger.warn(
      {
        request_id: options.requestId,
        company_id: options.ref.companyId,
      },
      "staff assistant budget hold could not be read",
    );
    return { hold, created: false };
  }
  // This turn's reservation was already taken — by the attempt this one is a
  // retry of. Give back what this request just took; the recorded hold is the
  // one that stands, and its owner is the only one that may release it.
  await subtractHold(options.logger, options.requestId, store, {
    companyKey,
    globalKey,
    hold,
  });
  return { hold: recorded, created: false };
}

async function reserveBudgetKey(options: {
  readonly store: AiBudgetStore;
  readonly key: string;
  readonly capUsd: number;
  readonly reserveUsd: number;
  readonly refuse: () => RateLimitError;
}): Promise<number> {
  let decision: AiBudgetTryAddDecision;
  try {
    decision = await options.store.tryAdd(
      options.key,
      options.reserveUsd,
      options.capUsd,
      AI_BUDGET_TTL_SEC,
    );
  } catch {
    throw options.refuse();
  }
  if (!decision.allowed) {
    throw options.refuse();
  }
  return options.reserveUsd;
}

/**
 * Gives back a reservation a *request* made, if it made one.
 *
 * The rule is structural rather than remembered: a request that found an
 * earlier attempt's reservation took nothing, and that attempt's turn row may
 * be holding it, so giving it back would put the counter below real spend and
 * lift the day's cap. Callers holding a `StaffAssistantBudgetReservation` use
 * this; whoever ends a turn row owns its hold by definition and uses
 * `releaseStaffAssistantBudgetHold` directly.
 */
export async function releaseUnusedReservation(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly ref: StaffAssistantBudgetHoldRef;
  readonly reservation: StaffAssistantBudgetReservation;
  readonly budgetStore?: AiBudgetStore | undefined;
}): Promise<void> {
  if (!options.reservation.created) {
    return;
  }
  await releaseStaffAssistantBudgetHold({
    logger: options.logger,
    requestId: options.requestId,
    ref: options.ref,
    hold: options.reservation.hold,
    budgetStore: options.budgetStore,
  });
}

/**
 * Gives a reservation back to the day's counters, at most once.
 *
 * The record `aiBudgetHoldKey` names is deleted first, and only the caller that
 * deleted it subtracts. Two parties can therefore both try — the request that
 * reserved, and whoever ends the turn row that took it over — and the counter
 * still moves once. That is the guarantee, not a convention: before it, the
 * day's counter drifted below real spend whenever both ran.
 *
 * A failure after the delete leaves the reservation standing until its
 * Kyiv-day key expires, which is the safe direction.
 */
export async function releaseStaffAssistantBudgetHold(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly ref: StaffAssistantBudgetHoldRef;
  readonly hold: StaffAssistantBudgetHold;
  readonly budgetStore?: AiBudgetStore | undefined;
}): Promise<void> {
  const store = options.budgetStore;
  if (store === undefined) {
    return;
  }
  const companyId = canonicalizeAiBudgetCompanyId(options.ref.companyId);
  const kyivDate = options.hold.kyivDate;
  try {
    const dropped = await store.dropHold(
      aiBudgetHoldKey({ ...options.ref, companyId, kyivDate }),
    );
    if (!dropped) {
      return;
    }
    await addBudgetDelta(
      store,
      aiCompanyBudgetKey(companyId, kyivDate),
      -options.hold.companyReservedUsd,
    );
    await addBudgetDelta(
      store,
      aiGlobalBudgetKey(kyivDate),
      -options.hold.globalReservedUsd,
    );
  } catch (error: unknown) {
    options.logger.error(
      {
        request_id: options.requestId,
        company_id: companyId,
        err: error,
      },
      "staff assistant budget reservation release failed",
    );
  }
}

/**
 * Undoes this request's own increments, without touching the record.
 *
 * Used only before a record exists, or when this request lost the race to
 * write one: there is nothing to compare-and-delete, and the amounts are this
 * request's own.
 */
async function subtractHold(
  logger: Logger,
  requestId: string,
  store: AiBudgetStore,
  keys: {
    readonly companyKey: string;
    readonly globalKey: string;
    readonly hold: StaffAssistantBudgetHold;
  },
): Promise<void> {
  try {
    await addBudgetDelta(store, keys.companyKey, -keys.hold.companyReservedUsd);
    await addBudgetDelta(store, keys.globalKey, -keys.hold.globalReservedUsd);
  } catch (error: unknown) {
    logger.error(
      { request_id: requestId, err: error },
      "staff assistant budget reservation release failed",
    );
  }
}

async function addBudgetDelta(
  store: AiBudgetStore,
  key: string,
  deltaUsd: number,
): Promise<void> {
  if (deltaUsd === 0) {
    return;
  }
  await store.add(key, deltaUsd, AI_BUDGET_TTL_SEC);
}

const MICRO_USD_PER_USD = 1_000_000;

/**
 * What the record holds: the two reserved amounts, as integers of millionths of
 * a dollar, so a retry adopts exactly what the first attempt took rather than
 * recomputing it from limits that may have been redeployed since.
 */
function encodeHold(hold: StaffAssistantBudgetHold): string {
  const company = Math.round(hold.companyReservedUsd * MICRO_USD_PER_USD);
  const global = Math.round(hold.globalReservedUsd * MICRO_USD_PER_USD);
  return `${String(company)}:${String(global)}`;
}

function decodeHold(
  value: string,
  kyivDate: string,
): StaffAssistantBudgetHold | null {
  const parts = value.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const company = Number(parts[0]);
  const global = Number(parts[1]);
  if (
    !Number.isFinite(company) ||
    !Number.isFinite(global) ||
    company < 0 ||
    global < 0
  ) {
    return null;
  }
  return {
    companyReservedUsd: company / MICRO_USD_PER_USD,
    globalReservedUsd: global / MICRO_USD_PER_USD,
    kyivDate,
  };
}
