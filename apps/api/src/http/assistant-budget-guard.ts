/**
 * Per-user turn limit and Kyiv-day USD budget for `POST /assistant/chat`
 * (SHO-505). Consumes core `RateLimitStore` and `AiBudgetStore`. Throws
 * `RateLimitError` — no new error code.
 *
 * Budget is reserved (increment-with-cap of `unknownModelTurnUsd`) before
 * the turn bucket is consumed, so a budget 429 does not spend a turn slot.
 */
import { kyivCalendarDate, secondsUntilKyivMidnight } from "@showzy/ai";
import type { RateLimitDecision, RateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import type { Logger } from "pino";

import {
  AI_BUDGET_TTL_SEC,
  AI_CHAT_TURN_WINDOW_SEC,
  aiChatTurnLimitKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  canonicalizeAiBudgetCompanyId,
  type AiBudgetStore,
  type AiBudgetTryAddDecision,
} from "../stores/budget.js";

export type StaffAssistantBudgetDenialReason =
  "turn_limit" | "company_budget" | "global_budget";

export interface StaffAssistantBudgetLimits {
  readonly chatTurnsPerMinutePerUser: number;
  readonly dailyBudgetUsdPerCompany: number;
  readonly dailyBudgetUsdGlobal: number;
  readonly unknownModelTurnUsd: number;
}

export const DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS: StaffAssistantBudgetLimits =
  {
    chatTurnsPerMinutePerUser: 20,
    dailyBudgetUsdPerCompany: 5,
    dailyBudgetUsdGlobal: 100,
    unknownModelTurnUsd: 0.1,
  };

export interface StaffAssistantBudgetHold {
  readonly companyReservedUsd: number;
  readonly globalReservedUsd: number;
}

export const EMPTY_STAFF_ASSISTANT_BUDGET_HOLD: StaffAssistantBudgetHold = {
  companyReservedUsd: 0,
  globalReservedUsd: 0,
};

export function staffAssistantBudgetSpendUsd(
  estimated: number | null,
  unknownModelTurnUsd: number,
): number {
  return estimated === null ? unknownModelTurnUsd : estimated;
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
  readonly skipTurnLimit: boolean;
  readonly now?: Date;
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<StaffAssistantBudgetHold> {
  const now = options.now ?? new Date();
  const kyivDate = kyivCalendarDate(now);
  const companyId = canonicalizeAiBudgetCompanyId(options.companyId);
  const companyKey = aiCompanyBudgetKey(companyId, kyivDate);
  const globalKey = aiGlobalBudgetKey(kyivDate);

  const hold = await reserveStaffAssistantBudget({
    logger: options.logger,
    requestId: options.requestId,
    companyId,
    companyKey,
    globalKey,
    retryAfterSec: secondsUntilKyivMidnight(now),
    budgetStore: options.budgetStore,
    limits: options.limits,
  });

  if (
    options.skipTurnLimit ||
    options.limits.chatTurnsPerMinutePerUser <= 0 ||
    options.rateLimitStore === undefined
  ) {
    return hold;
  }

  let decision: RateLimitDecision;
  try {
    decision = await options.rateLimitStore.consume({
      key: aiChatTurnLimitKey(options.userId),
      limit: options.limits.chatTurnsPerMinutePerUser,
      windowSec: AI_CHAT_TURN_WINDOW_SEC,
    });
  } catch {
    await releaseStaffAssistantBudgetHold({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      companyKey,
      globalKey,
      budgetStore: options.budgetStore,
      hold,
    });
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      reason: "turn_limit",
    });
    throw new RateLimitError(AI_CHAT_TURN_WINDOW_SEC);
  }
  if (!decision.allowed) {
    await releaseStaffAssistantBudgetHold({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      companyKey,
      globalKey,
      budgetStore: options.budgetStore,
      hold,
    });
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId,
      reason: "turn_limit",
    });
    throw new RateLimitError(decision.retryAfterSec);
  }
  return hold;
}

export async function recordStaffAssistantBudgetSpend(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly estimatedCostUsd: number | null;
  readonly hold: StaffAssistantBudgetHold;
  readonly now?: Date;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<void> {
  if (options.budgetStore === undefined) {
    return;
  }
  const companyId = canonicalizeAiBudgetCompanyId(options.companyId);
  const spend = staffAssistantBudgetSpendUsd(
    options.estimatedCostUsd,
    options.limits.unknownModelTurnUsd,
  );
  const now = options.now ?? new Date();
  const kyivDate = kyivCalendarDate(now);
  try {
    await addBudgetDelta(
      options.budgetStore,
      aiCompanyBudgetKey(companyId, kyivDate),
      spend - options.hold.companyReservedUsd,
    );
    await addBudgetDelta(
      options.budgetStore,
      aiGlobalBudgetKey(kyivDate),
      spend - options.hold.globalReservedUsd,
    );
  } catch (error: unknown) {
    options.logger.error(
      {
        request_id: options.requestId,
        company_id: companyId,
        err: error,
      },
      "staff assistant budget increment failed",
    );
  }
}

async function reserveStaffAssistantBudget(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly companyKey: string;
  readonly globalKey: string;
  readonly retryAfterSec: number;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<StaffAssistantBudgetHold> {
  if (options.budgetStore === undefined) {
    return EMPTY_STAFF_ASSISTANT_BUDGET_HOLD;
  }
  const hold: { companyReservedUsd: number; globalReservedUsd: number } = {
    companyReservedUsd: 0,
    globalReservedUsd: 0,
  };
  try {
    if (options.limits.dailyBudgetUsdPerCompany > 0) {
      hold.companyReservedUsd = await reserveBudgetKey({
        store: options.budgetStore,
        key: options.companyKey,
        capUsd: options.limits.dailyBudgetUsdPerCompany,
        reserveUsd: options.limits.unknownModelTurnUsd,
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "company_budget",
        retryAfterSec: options.retryAfterSec,
      });
    }
    if (options.limits.dailyBudgetUsdGlobal > 0) {
      hold.globalReservedUsd = await reserveBudgetKey({
        store: options.budgetStore,
        key: options.globalKey,
        capUsd: options.limits.dailyBudgetUsdGlobal,
        reserveUsd: options.limits.unknownModelTurnUsd,
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "global_budget",
        retryAfterSec: options.retryAfterSec,
      });
    }
  } catch (error: unknown) {
    await releaseStaffAssistantBudgetHold({
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.companyId,
      companyKey: options.companyKey,
      globalKey: options.globalKey,
      budgetStore: options.budgetStore,
      hold,
    });
    throw error;
  }
  return hold;
}

async function reserveBudgetKey(options: {
  readonly store: AiBudgetStore;
  readonly key: string;
  readonly capUsd: number;
  readonly reserveUsd: number;
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly reason: StaffAssistantBudgetDenialReason;
  readonly retryAfterSec: number;
}): Promise<number> {
  if (options.reserveUsd > 0) {
    let decision: AiBudgetTryAddDecision;
    try {
      decision = await options.store.tryAdd(
        options.key,
        options.reserveUsd,
        options.capUsd,
        AI_BUDGET_TTL_SEC,
      );
    } catch {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: options.reason,
      });
      throw new RateLimitError(options.retryAfterSec);
    }
    if (!decision.allowed) {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: options.reason,
      });
      throw new RateLimitError(options.retryAfterSec);
    }
    return options.reserveUsd;
  }
  const spent = await readBudgetOrDeny({
    store: options.store,
    key: options.key,
    logger: options.logger,
    requestId: options.requestId,
    companyId: options.companyId,
    reason: options.reason,
    retryAfterSec: options.retryAfterSec,
  });
  if (spent >= options.capUsd) {
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.companyId,
      reason: options.reason,
    });
    throw new RateLimitError(options.retryAfterSec);
  }
  return 0;
}

async function releaseStaffAssistantBudgetHold(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly companyKey: string;
  readonly globalKey: string;
  readonly budgetStore?: AiBudgetStore | undefined;
  readonly hold: StaffAssistantBudgetHold;
}): Promise<void> {
  if (options.budgetStore === undefined) {
    return;
  }
  try {
    await addBudgetDelta(
      options.budgetStore,
      options.companyKey,
      -options.hold.companyReservedUsd,
    );
    await addBudgetDelta(
      options.budgetStore,
      options.globalKey,
      -options.hold.globalReservedUsd,
    );
  } catch (error: unknown) {
    options.logger.error(
      {
        request_id: options.requestId,
        company_id: options.companyId,
        err: error,
      },
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

async function readBudgetOrDeny(options: {
  readonly store: AiBudgetStore;
  readonly key: string;
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly reason: StaffAssistantBudgetDenialReason;
  readonly retryAfterSec: number;
}): Promise<number> {
  try {
    return await options.store.read(options.key);
  } catch {
    logStaffAssistantBudgetDenial({
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.companyId,
      reason: options.reason,
    });
    throw new RateLimitError(options.retryAfterSec);
  }
}
