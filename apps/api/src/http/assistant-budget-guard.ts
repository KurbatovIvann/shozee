/**
 * Per-user turn limit and Kyiv-day USD budget for `POST /assistant/chat`
 * (SHO-505). Consumes core `RateLimitStore` and `AiBudgetStore`. Throws
 * `RateLimitError` — no new error code.
 */
import {
  kyivCalendarDate,
  secondsUntilKyivMidnight,
} from "@showzy/ai";
import type { RateLimitDecision, RateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import type { Logger } from "pino";

import {
  AI_BUDGET_TTL_SEC,
  AI_CHAT_TURN_WINDOW_SEC,
  aiChatTurnLimitKey,
  aiCompanyBudgetKey,
  aiGlobalBudgetKey,
  type AiBudgetStore,
} from "../stores/budget.js";

export type StaffAssistantBudgetDenialReason =
  | "turn_limit"
  | "company_budget"
  | "global_budget";

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
      company_id: options.companyId,
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
  readonly rateLimitStore?: RateLimitStore;
  readonly budgetStore?: AiBudgetStore;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<void> {
  const now = options.now ?? new Date();
  const kyivDate = kyivCalendarDate(now);
  const companyKey = aiCompanyBudgetKey(options.companyId, kyivDate);
  const globalKey = aiGlobalBudgetKey(kyivDate);

  if (
    !options.skipTurnLimit &&
    options.limits.chatTurnsPerMinutePerUser > 0 &&
    options.rateLimitStore !== undefined
  ) {
    let decision: RateLimitDecision;
    try {
      decision = await options.rateLimitStore.consume({
        key: aiChatTurnLimitKey(options.userId),
        limit: options.limits.chatTurnsPerMinutePerUser,
        windowSec: AI_CHAT_TURN_WINDOW_SEC,
      });
    } catch {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "turn_limit",
      });
      throw new RateLimitError(AI_CHAT_TURN_WINDOW_SEC);
    }
    if (!decision.allowed) {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "turn_limit",
      });
      throw new RateLimitError(decision.retryAfterSec);
    }
  }

  if (options.budgetStore === undefined) {
    return;
  }

  const retryAfterSec = secondsUntilKyivMidnight(now);
  if (options.limits.dailyBudgetUsdPerCompany > 0) {
    const spent = await readBudgetOrDeny({
      store: options.budgetStore,
      key: companyKey,
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.companyId,
      reason: "company_budget",
      retryAfterSec,
    });
    if (spent >= options.limits.dailyBudgetUsdPerCompany) {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "company_budget",
      });
      throw new RateLimitError(retryAfterSec);
    }
  }

  if (options.limits.dailyBudgetUsdGlobal > 0) {
    const spent = await readBudgetOrDeny({
      store: options.budgetStore,
      key: globalKey,
      logger: options.logger,
      requestId: options.requestId,
      companyId: options.companyId,
      reason: "global_budget",
      retryAfterSec,
    });
    if (spent >= options.limits.dailyBudgetUsdGlobal) {
      logStaffAssistantBudgetDenial({
        logger: options.logger,
        requestId: options.requestId,
        companyId: options.companyId,
        reason: "global_budget",
      });
      throw new RateLimitError(retryAfterSec);
    }
  }
}

export async function recordStaffAssistantBudgetSpend(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly companyId: string;
  readonly estimatedCostUsd: number | null;
  readonly now?: Date;
  readonly budgetStore?: AiBudgetStore;
  readonly limits: StaffAssistantBudgetLimits;
}): Promise<void> {
  if (options.budgetStore === undefined) {
    return;
  }
  const spend = staffAssistantBudgetSpendUsd(
    options.estimatedCostUsd,
    options.limits.unknownModelTurnUsd,
  );
  const now = options.now ?? new Date();
  const kyivDate = kyivCalendarDate(now);
  try {
    await options.budgetStore.add(
      aiCompanyBudgetKey(options.companyId, kyivDate),
      spend,
      AI_BUDGET_TTL_SEC,
    );
    await options.budgetStore.add(
      aiGlobalBudgetKey(kyivDate),
      spend,
      AI_BUDGET_TTL_SEC,
    );
  } catch (error: unknown) {
    options.logger.error(
      {
        request_id: options.requestId,
        company_id: options.companyId,
        err: error,
      },
      "staff assistant budget increment failed",
    );
  }
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
