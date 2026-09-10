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
  ChatDocument,
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
import { REQUEST_ID_HEADER } from "./request-id.js";

export type AssistantKitAppEnv = {
  Variables: { requestId: string; clientIp: string };
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
 * Model history for the next turn.
 *
 * Deliberately the consumer's, not the package's: how much of a conversation to
 * send, and how to clip a large tool result, is a budget and prompt question
 * that belongs to whoever pays for the tokens. The chat document is what a
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
  readonly session: { readonly userId: string };
  readonly companySelector: string;
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
 * through `executeAction`: the document and the history are read and written as
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
 * The rule it enforces: **a 2xx carries the whole document.** That was a
 * convention held in a comment, and `abandon` broke it by answering with an
 * object literal — the card stayed on screen, and the conversation locked until
 * the pause expired. A rule a handler can quietly not follow is a rule that will
 * eventually not be followed, so it is a type now and `json` accepts nothing
 * else.
 *
 * Two shapes deliberately carry no document. `expired` is the answer for a
 * conversation that is not yours *and* one that does not exist — attaching a
 * document to either would make an id a way to tell them apart. A fault carries
 * a code and nothing else, because there is nothing true to say about a
 * conversation the request never got to read.
 */
export type AssistantKitResponse =
  | { readonly status: "ok"; readonly document: ChatDocument }
  | { readonly status: "interaction_open"; readonly document: ChatDocument }
  | { readonly status: "stale"; readonly document: ChatDocument }
  | {
      readonly status: "unresolvable";
      readonly reason: string;
      readonly document: ChatDocument;
    }
  | {
      readonly status: "action_failed";
      readonly code: string;
      readonly message: string;
      readonly document: ChatDocument;
    }
  | { readonly status: "abandoned"; readonly document: ChatDocument }
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
