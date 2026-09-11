/**
 * What a turn needs from the server, whichever process runs it.
 *
 * Split out of the API's `AssistantKitRuntime` (ADR-0039): that type mixed the
 * request's concerns — the session lookup and the command receipts — with the
 * runtime. The runtime half is here, because the API and the worker both run
 * turns; the request half stays in `apps/api`.
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
import type { Logger } from "pino";

import type { AssistantInteractionTypes } from "./assistant-interactions.js";

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
 * The stores that act as one person, for one turn.
 *
 * Built per turn rather than once at boot because the durable half goes
 * through `executeAction`: the transcript and the history are read and written as
 * the caller, under the same tenant scope and author rule as every other read
 * of that conversation. There is no ambient principal to bake in.
 */
export interface AssistantKitScoped {
  readonly kit: AssistantKitFor;
  readonly history: AssistantHistoryPort;
}

/** Who a turn acts as, and the request it is audited under. */
export interface AssistantCaller {
  readonly userId: string;
  readonly companySelector: string;
  readonly requestId: string;
  readonly clientIp: string;
}

export interface AssistantRuntime {
  /** The pipeline's logger. Used for spend refusals, which are operational. */
  readonly logger: Logger;
  readonly forCaller: (caller: AssistantCaller) => AssistantKitScoped;
  readonly model: LanguageModel;
  /**
   * Built fresh per turn: the caller's permissions decide the set, and card
   * composition needs every result of one turn without leaking into another's.
   */
  readonly tools: (context: AssistantToolContext) => Promise<ToolSet>;
  readonly resolveAnswer: ResolveAnswer;
  /** Built per turn: the turn context carries the current time. */
  readonly prompt: () => AssistantTurnPrompt;
}
