/**
 * `@showzy/assistant-kit` — pause a tool call, ask a human, resume the model
 * conversation verbatim, and keep one stored chat document.
 *
 * An extension to AI SDK 7, not a replacement: the caller still owns the
 * single `streamText`. The kit owns only what happens between `stopWhen`
 * firing and the next request arriving.
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
  CHOICE_OPTIONS_MAX,
  choiceOptionSchema,
  isPausing,
  surfaceRefSchema,
  type ChoiceOption,
  type SurfaceRef,
  type ToolOutcome,
} from "./outcome.js";

export {
  PAUSE_KINDS,
  answerSchema,
  interactionResponseSchema,
  pauseStatusSchema,
  publicPauseSchema,
  type Answer,
  type AnswerKind,
  type ClaimResult,
  type Continuation,
  type InteractionResponse,
  type PauseKind,
  type PauseRecord,
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
 * The SDK types a consumer needs to wire this up. Re-exported so a consumer
 * does not take a direct `ai` dependency just to name a model or a tool set —
 * the same seam `@showzy/ai` provides for its own callers.
 */
export type { LanguageModel, ModelMessage, ToolSet } from "ai";
