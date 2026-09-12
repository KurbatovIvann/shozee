/**
 * Shared plumbing for the `assistant-kit` routes: who is asking, which tenant,
 * how a refusal is shaped, and how an accepted turn reaches the queue.
 *
 * All three handlers derive the same opaque owner token from the session and
 * the company header. The package treats it as opaque; getting it from one
 * place here is what keeps a route from accidentally scoping a pause more
 * loosely than its neighbours.
 *
 * What used to live here and no longer does: the conversation's turn lease and
 * the log line for a turn that did not finish. Since the switch (SHO-563) no
 * turn runs inside a request — the `assistant_turns` row is the lease, claimed
 * by the accept and released by whoever ends the turn, and the worker reports
 * an unfinished turn where it happens. A Redis lease held for the length of a
 * request would now be released while the turn was still running, which is
 * worse than none.
 */
import type {
  AssistantKitCommandRef,
  AssistantKitCommands,
  AssistantRuntime,
  AssistantToolContext,
  AssistantTurnJob,
  AssistantTurnQueue,
  StaffAssistantBudgetHold,
} from "@showzy/assistant-runtime";
import { enqueueAssistantTurn } from "@showzy/assistant-runtime";
import type { ChatWindow } from "@showzy/assistant-kit";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Context } from "hono";

import { REQUEST_ID_HEADER } from "./request-id.js";

export type AssistantKitAppEnv = {
  Variables: {
    requestId: string;
    clientIp: string;
    /**
     * The spend reservation this request made, handed down by the budget
     * wrapper so the handler can give it to the turn row (SHO-563). A turn that
     * is accepted keeps it; anything else gives it back.
     */
    assistantBudget?: AssistantKitBudgetTicket;
  };
};

/**
 * One request's budget reservation, and the two things a handler may do with
 * it.
 *
 * The wrapper reserves before the body is even parsed, but only the handler
 * knows whether a turn row took ownership. Passing the reservation down rather
 * than guessing from the status code is what keeps "who owes this hold" a
 * single answer: either a row holds it, or this request gives it back.
 */
export interface AssistantKitBudgetTicket {
  readonly hold: StaffAssistantBudgetHold;
  /**
   * The turn row holds this reservation now. The wrapper neither settles nor
   * releases it: the reservation stands as the charge, and the worker gives it
   * back if the turn never reached the model (ADR-0039).
   */
  keep(): void;
  /**
   * Give the reservation back. Idempotent, and a no-op once kept — the accept
   * store calls it for every outcome that stored no row, and the wrapper calls
   * it for every refusal that never reached an accept.
   */
  release(): Promise<void>;
}

/** The reservation this request made, or a wiring bug. */
export function requireBudgetTicket(
  c: Context<AssistantKitAppEnv>,
): AssistantKitBudgetTicket {
  const ticket = c.get("assistantBudget");
  if (ticket === undefined) {
    // Only reachable by mounting a spending route outside the guard, which is
    // exactly the failure the mount point exists to prevent.
    throw new CoreInvariantError(
      "assistant route ran without a budget reservation — mount wiring bug",
    );
  }
  return ticket;
}

/**
 * Both ids in the one casing everything downstream derives from.
 *
 * Applied the moment a body parses, before the command receipt, the
 * idempotency key, the turn row or its message ids exist. Postgres hands a
 * `uuid` back lowercase, so a continuation (Продовжити) reads the lowercased
 * id and derives its keys from that; a turn first stored under the client's
 * mixed-case id would derive different ones, and the SHO-547 double-write
 * reopens. One normalisation, at the edge, rather than a `toLowerCase()` at
 * each of the places that would have to remember.
 */
export function canonicalCommandIds<
  T extends { readonly commandId: string; readonly conversationId: string },
>(body: T): T {
  return {
    ...body,
    commandId: body.commandId.toLowerCase(),
    conversationId: body.conversationId.toLowerCase(),
  };
}

/**
 * Take this command, or say it was already taken.
 *
 * Still here after the switch, and still before the answer route's claim. The
 * accept is its own receipt — a repeated command comes back `replayed` — but
 * an answer claims the pause *before* it accepts, and a claim is exactly-once:
 * a retry that reached it would be told `gone`, and the person would be looking
 * at a card that can never be answered (SHO-547). The receipt is what makes the
 * retry arrive at the accept at all.
 */
export async function takeCommand(
  runtime: AssistantKitRuntime,
  command: AssistantKitCommandRef,
): Promise<boolean> {
  return await runtime.commands.take(command);
}

/**
 * Puts an accepted turn on the queue.
 *
 * A failure here is logged and nothing more: the turn is already a Postgres
 * row, and the reconciler enqueues a turn that never got a job (ADR-0039).
 * Failing the request instead would tell the person nothing happened while
 * their message and their placeholder are stored and their turn is about to
 * run.
 */
export async function enqueueAcceptedTurn(
  runtime: AssistantKitRuntime,
  job: AssistantTurnJob,
  requestId: string,
): Promise<void> {
  if (runtime.queue === undefined) {
    runtime.logger.warn(
      { request_id: requestId, conversation_id: job.conversationId },
      "assistant turn accepted with no queue configured",
    );
    return;
  }
  try {
    await enqueueAssistantTurn(runtime.queue, job);
  } catch (error) {
    runtime.logger.error(
      {
        request_id: requestId,
        conversation_id: job.conversationId,
        turn_kind: job.kind,
        err: error,
      },
      "assistant turn was accepted but not enqueued",
    );
  }
}

/**
 * The assistant as the routes see it: the shared runtime (ADR-0039) plus the
 * things only a request-serving process has.
 *
 * The runtime half — tools, stores, prompt, answer resolution, the turn store —
 * lives in `@showzy/assistant-runtime` because the worker runs turns too. Who
 * is asking, whether this command was already taken, and the queue this process
 * produces onto are the API's business.
 */
export interface AssistantKitRuntime extends AssistantRuntime {
  /**
   * One attempt, once — the guard in front of the answer route's claim.
   */
  readonly commands: AssistantKitCommands;
  /**
   * The assistant queue, on the dedicated queue Redis (`REDIS_QUEUE_URL`),
   * never the shared one, which holds OTP codes and does not persist
   * (`db.md` §6). Absent in a composition without a queue: the turn is still
   * accepted and the reconciler enqueues it.
   */
  readonly queue?: AssistantTurnQueue;
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
        /** Set by the event stream's re-check; see `AuthInstance`. */
        query?: { disableRefresh?: boolean; disableCookieCache?: boolean };
      }) => Promise<{
        user: { id: string };
        session: { id: string };
      } | null>;
    };
  };
}

/**
 * Every answer these routes can give, as one type.
 *
 * The rule it enforces: **a 2xx carries the conversation as it now stands** —
 * its latest window, with the open question. That was a
 * convention held in a comment, and `abandon` broke it by answering with an
 * object literal — the card stayed on screen, and the conversation locked until
 * the pause expired. A rule a handler can quietly not follow is a rule that will
 * eventually not be followed, so it is a type now and `json` accepts nothing
 * else.
 *
 * `accepted` is the switch (SHO-563): the turn is stored and queued, and the
 * window already holds the person's message and the assistant's placeholder, so
 * a client that does nothing but render it shows the thread correctly while the
 * turn runs elsewhere.
 *
 * Two shapes deliberately carry no window. `expired` is the answer for a
 * conversation that is not yours *and* one that does not exist — attaching a
 * window to either would make an id a way to tell them apart. A fault carries
 * a code and nothing else, because there is nothing true to say about a
 * conversation the request never got to read.
 */
export type AssistantKitResponse =
  | { readonly status: "ok"; readonly window: ChatWindow }
  /** Stored and queued; it runs off the request (ADR-0039). */
  | { readonly status: "accepted"; readonly window: ChatWindow }
  | { readonly status: "interaction_open"; readonly window: ChatWindow }
  /** Another turn holds this conversation. Nothing was attempted. */
  | { readonly status: "turn_open"; readonly window: ChatWindow }
  | { readonly status: "stale"; readonly window: ChatWindow }
  | {
      readonly status: "unresolvable";
      readonly reason: string;
      readonly window: ChatWindow;
    }
  | {
      readonly status: "action_failed";
      readonly code: string;
      readonly message: string;
      readonly window: ChatWindow;
    }
  | { readonly status: "abandoned"; readonly window: ChatWindow }
  | { readonly status: "expired" }
  | { readonly status: "pause_rejected"; readonly reason: string }
  | {
      readonly error: { readonly code: string };
      readonly retryAfterSec?: number;
    };

export function json(
  status: number,
  body: AssistantKitResponse,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

/**
 * Gone, expired, owned by someone else, or of a kind this deployment no longer
 * registers — all answer the same way. Distinguishing them would let one tenant
 * probe another's conversation.
 */
export function goneResponse(requestId: string): Response {
  return json(410, { status: "expired" }, requestId);
}

export function toolContext(
  c: Context<AssistantKitAppEnv>,
  caller: Extract<Caller, { ok: true }>,
  command: { readonly conversationId: string; readonly commandId: string },
): AssistantToolContext {
  return {
    userId: caller.userId,
    companySelector: caller.companySelector,
    conversationId: command.conversationId,
    commandId: command.commandId,
    requestId: c.get("requestId"),
    clientIp: c.get("clientIp"),
  };
}

export type Caller =
  | { readonly ok: false; readonly response: Response }
  | {
      readonly ok: true;
      readonly userId: string;
      readonly companySelector: string;
      /**
       * better-auth's `session.id` for this request, recorded on an accepted
       * turn. Never an identity: the turn's actor is the verified caller
       * (ADR-0039, amended SHO-561).
       */
      readonly sessionId: string;
      /** Identity and tenant together. Opaque to the package. */
      readonly bind: string;
    };

export async function requireCaller(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
): Promise<Caller> {
  const requestId = c.get("requestId");
  const session = await runtime.auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (session === null) {
    return {
      ok: false,
      response: json(401, { error: { code: "UNAUTHENTICATED" } }, requestId),
    };
  }
  const companySelector = c.req.header(COMPANY_SELECTOR_HEADER);
  if (companySelector === undefined || companySelector.length === 0) {
    return {
      ok: false,
      response: json(400, { error: { code: "VALIDATION" } }, requestId),
    };
  }
  return {
    ok: true,
    userId: session.user.id,
    companySelector,
    sessionId: session.session.id,
    bind: `${session.user.id}:${companySelector}`,
  };
}

export async function readJson(
  c: Context<AssistantKitAppEnv>,
): Promise<
  { readonly ok: true; readonly body: unknown } | { readonly ok: false }
> {
  try {
    return { ok: true, body: await c.req.raw.json() };
  } catch {
    return { ok: false };
  }
}
