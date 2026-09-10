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
  HostTurnOptions,
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
  readonly kit: AssistantKitFor;
  readonly model: LanguageModel;
  /**
   * Built fresh per request: the caller's permissions decide the set, and card
   * composition needs every result of one turn without leaking into another's.
   */
  readonly tools: (context: AssistantToolContext) => Promise<ToolSet>;
  readonly history: AssistantHistoryPort;
  readonly resolveAnswer: ResolveAnswer;
  /** Built per turn: the turn context carries the current time. */
  readonly prompt: () => AssistantTurnPrompt;
}

export function json(
  status: number,
  body: unknown,
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
