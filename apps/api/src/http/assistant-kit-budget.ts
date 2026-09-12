/**
 * The spend ceiling on the `assistant-kit` routes.
 *
 * The same guard the previous assistant used, on the same Redis keys and the
 * same per-user bucket — this is a change of mount point, not a second
 * implementation. Sharing the keys is deliberate: one person's turns and one
 * company's Kyiv-day budget are the same quantities whichever route spent them.
 *
 * It wraps the handlers rather than living inside them. A route that calls the
 * model must be admitted before it runs, and putting that at the mount point
 * means a route cannot be added without a decision about which it is — the
 * failure mode being guarded against is a new endpoint that quietly costs
 * money.
 *
 * **Reserve, then accept or give it back (SHO-563).** Since the switch no turn
 * runs inside the request, so there is nothing here to settle afterwards: the
 * reservation *is* the charge, and it travels onto the turn row, which is why
 * the reservation is handed to the handler as a ticket. A turn that is accepted
 * keeps it — the worker releases it if the turn never reached the model, and
 * the reconciler does the same for a turn that can never start. Every other
 * outcome, a replayed command included, gives it back here.
 */
import {
  acceptProvedRollback,
  canonicalizeAiBudgetCompanyId,
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  enforceStaffAssistantBudget,
  releaseStaffAssistantBudgetHold,
  type AiBudgetStore,
  type StaffAssistantBudgetLimits,
} from "@showzy/assistant-runtime";
import type { RateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import type { Context } from "hono";
import type { Logger } from "pino";

import {
  json,
  requireCaller,
  type AssistantKitAppEnv,
  type AssistantKitBudgetTicket,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export interface AssistantKitBudget {
  readonly logger: Logger;
  readonly limits: StaffAssistantBudgetLimits;
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly budgetStore?: AiBudgetStore | undefined;
}

/**
 * Stores that live in this process only.
 *
 * For tests and for a single-process run. `app.ts` always passes the real ones,
 * so this is a fallback rather than a switch — there is deliberately no way to
 * mount these routes with no ceiling at all.
 */
export function memoryAssistantKitBudget(
  logger: Logger,
  stores: {
    readonly rateLimitStore: RateLimitStore;
    readonly budgetStore: AiBudgetStore;
  },
): AssistantKitBudget {
  return {
    logger,
    limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
    rateLimitStore: stores.rateLimitStore,
    budgetStore: stores.budgetStore,
  };
}

function rateLimitResponse(error: RateLimitError, requestId: string): Response {
  const response = json(
    429,
    {
      error: { code: error.code },
      retryAfterSec: error.retryAfterSec,
    },
    requestId,
  );
  response.headers.set("Retry-After", String(error.retryAfterSec));
  return response;
}

/**
 * `skipTurnLimit` is for answering an open question.
 *
 * The per-minute bucket exists to cap how often a person can start new work.
 * Answering a question the assistant asked is finishing work already admitted,
 * and refusing it would strand a draft behind a limit the person cannot wait
 * out. The USD ceiling still applies: that one is about money, and a resumed
 * turn costs the same as any other.
 */
export async function withAssistantKitBudget(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
  budget: AssistantKitBudget,
  options: { readonly skipTurnLimit: boolean },
  handle: () => Promise<Response>,
): Promise<Response> {
  const requestId = c.get("requestId");

  // Resolved here for the budget keys, and again inside the handler for its own
  // work. One extra session read per turn, against a guard that cannot be
  // forgotten at the call site.
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }
  const companyId = canonicalizeAiBudgetCompanyId(caller.companySelector);

  let hold;
  try {
    hold = await enforceStaffAssistantBudget({
      logger: budget.logger,
      requestId,
      userId: caller.userId,
      companyId,
      skipTurnLimit: options.skipTurnLimit,
      ...(budget.rateLimitStore === undefined
        ? {}
        : { rateLimitStore: budget.rateLimitStore }),
      ...(budget.budgetStore === undefined
        ? {}
        : { budgetStore: budget.budgetStore }),
      limits: budget.limits,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return rateLimitResponse(error, requestId);
    }
    throw error;
  }

  let kept = false;
  let given = false;
  const giveBack = async (): Promise<void> => {
    if (kept || given) {
      return;
    }
    given = true;
    await releaseStaffAssistantBudgetHold({
      logger: budget.logger,
      requestId,
      companyId,
      hold,
      ...(budget.budgetStore === undefined
        ? {}
        : { budgetStore: budget.budgetStore }),
    });
  };
  const ticket: AssistantKitBudgetTicket = {
    hold,
    keep: () => {
      kept = true;
    },
    release: giveBack,
  };
  c.set("assistantBudget", ticket);

  try {
    return await handle();
  } catch (error) {
    // The handler threw. Unless the failure proves nothing was stored, a turn
    // row may already hold this reservation, and giving it back would put the
    // counter below real spend — lifting the day's cap instead of failing
    // closed. That is the same reasoning, and the same predicate, the turn
    // store applies to its own release.
    //
    // Who owns a hold after a failed accept is currently answered in three
    // places — here, that predicate, and the turn row. Reconciling them is
    // SHO-572's, not this slice's.
    if (!acceptProvedRollback(error)) {
      ticket.keep();
    }
    throw error;
  } finally {
    // A turn row owns it, or nobody does. The per-minute bucket above still
    // counted a replayed command: that one is admission control on how often a
    // person may ask, and a retry is an ask. Money is the quantity that must
    // not double, and a replay gives its reservation straight back.
    await giveBack();
  }
}
