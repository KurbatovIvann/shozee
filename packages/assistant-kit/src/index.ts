/**
 * `assistant-kit` — pause a tool call, ask a person, resume the model
 * conversation verbatim, and keep one stored chat document.
 *
 * An extension to the AI SDK, not a replacement: the caller still owns the
 * single `streamText`. This package owns only what happens between the loop
 * stopping and the next request arriving.
 *
 * It knows nothing about any application. What kinds of question exist, what a
 * valid answer to each looks like, and what may appear on a card are all the
 * caller's registry — so the set of kinds is derived from that registry rather
 * than declared here.
 */
export {
  PROVIDER_TOOL_CALL_ID_PATTERN,
  cardIdSchema,
  conversationIdSchema,
  interactionIdSchema,
  providerToolCallId,
  providerToolCallIdSchema,
  revisionSchema,
  type ProviderToolCallId,
  type ProviderToolCallIdResult,
} from "./ids.js";

export {
  createInteractions,
  defineInteraction,
  resolved,
  unresolvable,
  type AnyInteraction,
  type InteractionRegistry,
  type InteractionSpec,
  type InteractionType,
  type KindOf,
  type Resolution,
} from "./interaction.js";

export {
  cardRefSchema,
  isPause,
  type CardRef,
  type ToolOutcome,
} from "./outcome.js";

export {
  interactionResponseSchema,
  pauseStatusSchema,
  publicPauseSchema,
  type ClaimResult,
  type Continuation,
  type InteractionResponse,
  type PauseRecord,
  type PauseScope,
  type PauseStatus,
  type PublicPause,
  type ResumeInput,
} from "./pause.js";

export {
  chatDocumentSchema,
  documentMessageSchema,
  documentPartSchema,
  textPartStatusSchema,
  type ChatDocument,
  type DocumentMessage,
  type DocumentPart,
  type DocumentWrite,
} from "./document.js";

export type {
  Clock,
  DocumentStore,
  Ids,
  KitDeps,
  PauseStore,
} from "./ports.js";

export {
  createAssistantKit,
  type AssistantKit,
  type OpenPauseInput,
  type OpenPauseResult,
  type RevisePauseResult,
} from "./kit.js";

export {
  HOST_SKIPPED_OUTPUT,
  continueHostTurn,
  runHostTurn,
  type ContinueHostTurnOptions,
  type HostTurnOptions,
  type HostTurnResult,
} from "./host.js";

/**
 * The SDK types a consumer needs to wire this up, re-exported so a consumer
 * does not take a direct `ai` dependency just to name a model or a tool set.
 */
export type {
  LanguageModel,
  ModelMessage,
  SystemModelMessage,
  ToolSet,
} from "ai";
