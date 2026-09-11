/**
 * Shared plumbing for the `assistant-kit` routes: who is asking, which tenant,
 * and how a refusal is shaped.
 *
 * All three handlers derive the same opaque owner token from the session and
 * the company header. The package treats it as opaque; getting it from one
 * place here is what keeps a route from accidentally scoping a pause more
 * loosely than its neighbours.
 */
import type {
  AssistantKit,
  ChatWindow,
  HostTurnOptions,
  HostTurnResult,
  LanguageModel,
  ModelMessage,
  PauseScope,
  ToolOutcome,
  ToolSet,
} from "@showzy/assistant-kit";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import type { Context } from "hono";
import type { Logger } from "pino";

import type { AssistantInteractionTypes } from "./assistant-interactions.js";
import type {
  AssistantKitCommandRef,
  AssistantKitCommands,
} from "../stores/assistant-kit-stores.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export type AssistantKitAppEnv = {
  Variables: {
    requestId: string;
    clientIp: string;
    /**
     * Set when a route answered a command it had already run. Read by the
     * budget wrapper, which must not charge a turn for a reply it re-read: a
     * person whose connection keeps dropping would otherwise spend their
     * per-minute allowance on retries of work that already happened.
     */
    replayedCommand?: boolean;
  };
};

/**
 * What a tool set needs to exist: domain actions run **as the caller**, so the
 * set cannot be built once at boot. Permissions decide which tools are even
 * offered, and that is a read against the actor.
 */
export interface AssistantToolContext {
  readonly userId: string;
  readonly companySelector: string;
  readonly conversationId: string;
  /**
   * The client's own token for this request. It is what makes a retry of the
   * same tap the *same* attempt: a model-regenerated `toolCallId` is not, which
   * is why the idempotency key is built from this instead.
   */
  readonly commandId: string;
  readonly requestId: string;
  readonly clientIp: string;
}

export type AssistantKitFor = AssistantKit<AssistantInteractionTypes>;

/**
 * How many messages one answer carries.
 *
 * A request writes at most two messages — the person's words and the reply, or
 * a second question — and a new turn is refused while a question is open, so
 * the turn just taken and the message that asked the open question are always
 * inside it. Thirty is a screen and a half of a phone thread; anything older is
 * one page away (SHO-555).
 */
export const ASSISTANT_CHAT_WINDOW_MESSAGES = 30;

/**
 * Model history for the next turn.
 *
 * Deliberately the consumer's, not the package's: how much of a conversation to
 * send, and how to clip a large tool result, is a budget and prompt question
 * that belongs to whoever pays for the tokens. The transcript is what a
 * person reads; this is what the model reads, and they are not the same thing.
 */
export interface AssistantHistoryPort {
  load(scope: PauseScope): Promise<ModelMessage[]>;
  save(scope: PauseScope, messages: readonly ModelMessage[]): Promise<void>;
}

/**
 * Runs the real action with whatever an interaction resolved to.
 *
 * It is handed the **same** tool set the turn is using, so resolving an
 * ambiguity is another call through the same façade — and a second ambiguity
 * comes back as another pause rather than as a failure.
 */
export type ResolveAnswer = (args: {
  readonly toolName: string;
  readonly kind: string;
  readonly value: unknown;
  readonly tools: ToolSet;
  /**
   * The request the answer arrived on: who is answering, in which company. A
   * confirmed action runs as this person, but under the attempt stored with the
   * pause — never under this request's own command.
   */
  readonly context: AssistantToolContext;
}) => Promise<ToolOutcome>;

/**
 * The instructions the model runs under, and how the provider should treat
 * them.
 *
 * Separate from the tools on purpose: this is the half of the learned
 * behaviour that does not live in a tool description, and forgetting it is
 * silent — the assistant simply answers worse.
 */
export interface AssistantTurnPrompt {
  readonly system: NonNullable<HostTurnOptions<never>["system"]>;
  readonly providerOptions?: NonNullable<
    HostTurnOptions<never>["providerOptions"]
  >;
}

/**
 * Run this handler holding the conversation, or refuse.
 *
 * Two turns on one conversation — two devices, two tabs, a session left open on
 * a laptop — interleave their messages, and the second turn's model answers a
 * conversation that no longer exists as it read it (SHO-548). The message log
 * refuses a write into anything but the latest message, so the storage half now
 * fails loudly instead of silently; the conversation half is still this lock's.
 * `busy` in a client is per client and the serial tool chain inside a turn is
 * per turn, so neither is a guarantee across requests.
 *
 * This existed before, as `conversationLock` in `app.ts`, and was deleted in
 * phase 2 with the routes that used it. The same class as the history window:
 * a guarantee that travelled out with code being removed for other reasons.
 *
 * Refused rather than queued. The second turn's model would be answering
 * without knowing what the first one is doing, so ordering the two would
 * produce a reply to a conversation that no longer exists as it was read.
 */
export async function withConversationTurn(
  runtime: AssistantKitRuntime,
  kit: AssistantKitFor,
  scope: PauseScope,
  requestId: string,
  handle: () => Promise<Response>,
): Promise<Response> {
  const lease = await kit.turn.begin(scope);
  if (lease.kind === "busy") {
    return json(
      409,
      { status: "turn_open", window: await kit.messages.read(scope) },
      requestId,
    );
  }
  try {
    return await handle();
  } finally {
    if (!(await kit.turn.end(scope, lease.token))) {
      // The lease lapsed while the turn was still running, which means another
      // turn may have started alongside it — the thing the lock exists to
      // prevent. Reported rather than swallowed: it is the signal that
      // `TURN_LEASE_MS` is too short for what this deployment's turns cost.
      runtime.logger.warn(
        { request_id: requestId },
        "assistant turn outlived its lease",
      );
    }
  }
}

/**
 * Take this command, or say it was already taken.
 *
 * Called at the point where a request stops being a question and starts being
 * work — after the refusals, after the abort check, before the first write.
 * Placement is the whole design: a command taken by a request that then refuses
 * would be spent without running, and the person could not retry it.
 *
 * A replay answers `ok` with the current window rather than a status of its
 * own. There is nothing for a client to do differently, and the honest answer
 * to "did my command run?" is the conversation itself.
 */
export async function takeCommand(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
  command: AssistantKitCommandRef,
): Promise<boolean> {
  const taken = await runtime.commands.take(command);
  if (!taken) {
    c.set("replayedCommand", true);
  }
  return taken;
}

/**
 * A turn that ended before it finished, named in the log.
 *
 * Otherwise this is silent on both sides. The person's request was aborted, so
 * no response reaches them to say so; and a provider error after the first step
 * is swallowed by `consumeStream`, so the server sees an ordinary result with
 * an empty reply. The one thing that would have made it visible — an exception
 * — is exactly what does not happen.
 *
 * Shape only. How many cards were written says whether something was committed
 * without an explanation, and whether history survived says whether the model
 * will remember it; neither carries a word the staff member typed.
 */
export function logInterruptedTurn(
  runtime: AssistantKitRuntime,
  fields: {
    readonly requestId: string;
    readonly turn: HostTurnResult;
    readonly priorMessages: number;
  },
): void {
  if (!fields.turn.interrupted) {
    return;
  }
  runtime.logger.warn(
    {
      request_id: fields.requestId,
      cards_written: fields.turn.parts.filter((part) => part.kind === "card")
        .length,
      history_kept: fields.turn.messages.length > fields.priorMessages,
    },
    "assistant turn did not finish",
  );
}

/**
 * The stores that act as one person, for one request.
 *
 * Built per request rather than once at boot because the durable half goes
 * through `executeAction`: the transcript and the history are read and written as
 * the caller, under the same tenant scope and author rule as every other read
 * of that conversation. There is no ambient principal to bake in.
 */
export interface AssistantKitScoped {
  readonly kit: AssistantKitFor;
  readonly history: AssistantHistoryPort;
}

export interface AssistantKitRuntime {
  /** The pipeline's logger. Used for spend refusals, which are operational. */
  readonly logger: Logger;
  /**
   * One attempt, once. A retry of a request whose reply was lost must not run
   * the write a second time — see `replayedCommand`.
   */
  readonly commands: AssistantKitCommands;
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
      }) => Promise<{ user: { id: string } } | null>;
    };
  };
  readonly forCaller: (caller: {
    readonly userId: string;
    readonly companySelector: string;
    readonly requestId: string;
    readonly clientIp: string;
  }) => AssistantKitScoped;
  readonly model: LanguageModel;
  /**
   * Built fresh per request: the caller's permissions decide the set, and card
   * composition needs every result of one turn without leaking into another's.
   */
  readonly tools: (context: AssistantToolContext) => Promise<ToolSet>;
  readonly resolveAnswer: ResolveAnswer;
  /** Built per turn: the turn context carries the current time. */
  readonly prompt: () => AssistantTurnPrompt;
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
 * Two shapes deliberately carry no window. `expired` is the answer for a
 * conversation that is not yours *and* one that does not exist — attaching a
 * window to either would make an id a way to tell them apart. A fault carries
 * a code and nothing else, because there is nothing true to say about a
 * conversation the request never got to read.
 */
export type AssistantKitResponse =
  | { readonly status: "ok"; readonly window: ChatWindow }
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
  | { readonly status: "aborted" }
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
