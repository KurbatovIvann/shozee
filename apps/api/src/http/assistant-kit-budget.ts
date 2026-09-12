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
 * the reconciler does the same for a turn that can never start.
 *
 * **The reservation belongs to the turn, not to this request (SHO-572).** It is
 * keyed by the turn's own identity — kind, conversation and command, the same
 * identity `assistant_turns` is keyed by — so a retry of a command whose first
 * attempt failed finds that attempt's reservation and takes none of its own.
 * Without that, a run of failed accepts during a database incident would strand
 * one reservation per retry and lock a company out of the assistant until Kyiv
 * midnight. Reading the command here is the only reason this wrapper parses the
 * body at all; the handler parses it properly, from Hono's cache.
 *
 * **Who owns the hold, in one sentence:** a request gives back only a
 * reservation it took itself and never handed to an accept. Once an accept has
 * it, the turn store decides — it releases what it can prove no row took, and
 * keeps what a commit may already own — and after that the row does, until
 * whoever ends the turn releases it. This wrapper therefore asks no question
 * about *why* a request failed; the accept is the only thing that can put a
 * reservation on a row, so whether it got one is the whole answer. That also
 * covers a throw before any accept was attempted — from `kit.peek`,
 * `kit.claim`, `runtime.tools`, `resolveAnswer` or `kit.open` — which no turn
 * row could ever own and which is now given back rather than stranded.
 */
import {
  canonicalizeAiBudgetCompanyId,
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  enforceStaffAssistantBudget,
  releaseUnusedReservation,
  type AiBudgetStore,
  type StaffAssistantBudgetLimits,
  type StaffAssistantTurnIdentity,
} from "@showzy/assistant-runtime";
import type { RateLimitStore } from "@showzy/core";
import { RateLimitError } from "@showzy/core/errors";
import type { Context } from "hono";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  json,
  readJson,
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
 * Just enough of the body to name the turn. The handler validates it properly
 * and answers 400; this only has to decide which reservation is being asked
 * for, so it is deliberately loose about everything else.
 */
const budgetTurnBodySchema = z.object({
  commandId: z.uuid(),
  conversationId: z.uuid(),
});

/**
 * Which turn this request is reserving for.
 *
 * Lowercased here for the same reason the handlers lowercase at parse: Redis
 * keys are case-sensitive and Postgres returns a `uuid` lowercase, so a retry
 * spelling its command differently has to reach the same reservation.
 *
 * A body that names no turn cannot become one — the handler is about to answer
 * 400 — so it reserves under an identity of its own that nothing else can
 * share, and the reservation is given back on the way out. Admission control is
 * unchanged by a malformed body, which is the point of the guard sitting here.
 */
async function budgetTurnIdentity(
  c: Context<AssistantKitAppEnv>,
  kind: "chat" | "answer",
): Promise<StaffAssistantTurnIdentity> {
  const raw = await readJson(c);
  const parsed = raw.ok
    ? budgetTurnBodySchema.safeParse(raw.body)
    : ({ success: false } as const);
  if (!parsed.success) {
    return { kind, conversationId: randomUUID(), commandId: randomUUID() };
  }
  return {
    kind,
    conversationId: parsed.data.conversationId.toLowerCase(),
    commandId: parsed.data.commandId.toLowerCase(),
  };
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
  options: {
    readonly skipTurnLimit: boolean;
    /** Which turn this route accepts. Part of the reservation's identity. */
    readonly turnKind: "chat" | "answer";
  },
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
  const turn = await budgetTurnIdentity(c, options.turnKind);

  let reservation;
  try {
    reservation = await enforceStaffAssistantBudget({
      logger: budget.logger,
      requestId,
      userId: caller.userId,
      companyId,
      turn,
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

  // One mutable record rather than three captured flags: the handler runs
  // between the writes and the reads, so these are state, not constants.
  const fate = { handedOver: false, kept: false, given: false };
  const giveBack = async (): Promise<void> => {
    if (fate.kept || fate.given) {
      return;
    }
    fate.given = true;
    // Only what this request took: `releaseUnusedReservation` does nothing for
    // a retry that found an earlier attempt's reservation, whose turn row may
    // be holding it.
    await releaseUnusedReservation({
      logger: budget.logger,
      requestId,
      ref: { ...turn, companyId },
      reservation,
      ...(budget.budgetStore === undefined
        ? {}
        : { budgetStore: budget.budgetStore }),
    });
  };
  const ticket: AssistantKitBudgetTicket = {
    hold: reservation.hold,
    handOverToAccept: () => {
      fate.handedOver = true;
      return reservation.hold;
    },
    keep: () => {
      fate.kept = true;
    },
    release: giveBack,
  };
  c.set("assistantBudget", ticket);

  try {
    return await handle();
  } finally {
    // A reservation that never reached an accept can belong to nothing: no turn
    // row names it, and no retry will find it useful, so it goes back. Once an
    // accept has it the store has already decided — `releaseUnusedHold` for
    // every outcome that stored no row, nothing at all for a failure that may
    // have committed — and this must not decide again.
    if (!fate.handedOver) {
      await giveBack();
    }
  }
}
