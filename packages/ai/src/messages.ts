import type { ModelMessage } from "ai";
import { z } from "zod";

import { STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS } from "./anthropic-options.js";
import { confirmationFromChatPart } from "./confirmation.js";
import {
  budgetStaffAssistantToolRuns,
  staffAssistantToolResultChars,
  staffAssistantToolResultOutput,
  staffAssistantToolSetKey,
  type StaffAssistantPersistedMessage,
} from "./model-trace.js";
import { staffAssistantLocaleSchema } from "./presenter.js";

/**
 * Match `assistant` `messageBodySchema` (16_000). Request validation so
 * append and the model payload cannot diverge — not a core.md §10
 * conversation-budget hook.
 */
export const STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX = 16_000;
export const STAFF_ASSISTANT_CHAT_MESSAGES_MAX = 50;
export const STAFF_ASSISTANT_CHAT_PARTS_MAX = 32;
/** Last user/assistant text turns sent to the model (SHO-349). */
export const STAFF_ASSISTANT_MODEL_HISTORY_MAX = 8;

/**
 * Dropping an empty assistant message must not leave two consecutive user
 * turns (SHO-429). The client may post `parts: []` after a silent tool
 * error; keep a non-empty assistant line so the next user request is not
 * merged with the previous one.
 */
export const STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER =
  "The previous assistant turn had no spoken text.";

const chatPartSchema = z.looseObject({
  type: z.string().min(1).max(64),
  text: z.string().max(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX).optional(),
});

function textFromParts(
  parts: ReadonlyArray<{ type: string; text?: string | undefined }>,
): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

export const staffAssistantChatMessageSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(["system", "user", "assistant"]),
    parts: z
      .array(chatPartSchema)
      .max(STAFF_ASSISTANT_CHAT_PARTS_MAX)
      .default([]),
  })
  .superRefine((message, ctx) => {
    if (
      textFromParts(message.parts).length >
      STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["parts"],
        message: `Message text must be at most ${String(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX)} characters.`,
      });
    }
  });

export type StaffAssistantChatMessage = z.infer<
  typeof staffAssistantChatMessageSchema
>;

export interface StaffUserMessageAttempt {
  readonly id: string;
  readonly text: string;
}

export function lastStaffAssistantUserMessage(
  messages: readonly StaffAssistantChatMessage[],
): StaffUserMessageAttempt | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    const text = textFromParts(message.parts);
    if (text !== "") {
      return { id: message.id, text };
    }
  }
  return undefined;
}

const MIXED_CHAT_BODY_MESSAGE =
  "Chat body must not mix incomplete or conflicting message representations.";

export const staffAssistantChatBodySchema = z
  .strictObject({
    conversationId: z.uuid(),
    text: z
      .string()
      .min(1)
      .max(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX)
      .optional(),
    messageId: z.string().min(1).max(128).optional(),
    messages: z
      .array(staffAssistantChatMessageSchema)
      .max(STAFF_ASSISTANT_CHAT_MESSAGES_MAX)
      .optional(),
    locale: staffAssistantLocaleSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const hasText = body.text !== undefined;
    const hasMessageId = body.messageId !== undefined;
    if (hasText !== hasMessageId) {
      ctx.addIssue({
        code: "custom",
        path: hasText ? ["messageId"] : ["text"],
        message: MIXED_CHAT_BODY_MESSAGE,
      });
      return;
    }
    if (!hasText || body.messages === undefined) {
      return;
    }
    const lastUser = lastStaffAssistantUserMessage(body.messages);
    if (lastUser === undefined) {
      return;
    }
    if (lastUser.text !== body.text || lastUser.id !== body.messageId) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: MIXED_CHAT_BODY_MESSAGE,
      });
    }
  });

export type StaffAssistantChatBody = z.infer<
  typeof staffAssistantChatBodySchema
>;

/**
 * Fresh `text` + `messageId` win. Legacy bodies without those fields
 * derive both from the last user message. Never invents an attempt id.
 */
export function resolveStaffAssistantChatUserMessage(
  body: StaffAssistantChatBody,
): StaffUserMessageAttempt | undefined {
  if (body.text !== undefined && body.messageId !== undefined) {
    return { id: body.messageId, text: body.text };
  }
  if (body.messages === undefined) {
    return undefined;
  }
  return lastStaffAssistantUserMessage(body.messages);
}

export type {
  StaffAssistantPersistedMessage,
  StaffAssistantPersistedToolRun,
} from "./model-trace.js";

/**
 * Model history from persisted conversation rows. Client `messages` are
 * never a history source (SHO-506). Tool-call/result parts come from
 * ADR-0034 `modelTrace` under the read-time token budget (SHO-510).
 */
export function staffAssistantModelMessagesFromPersisted(
  messages: readonly StaffAssistantPersistedMessage[],
): ModelMessage[] {
  const budgeted = budgetStaffAssistantToolRuns(messages);
  const expanded: ModelMessage[] = [];
  for (const message of budgeted) {
    expanded.push(...modelMessagesFromPersistedRow(message));
  }
  return applyStaffAssistantHistoryWindow(expanded);
}

function modelMessagesFromPersistedRow(
  message: StaffAssistantPersistedMessage,
): ModelMessage[] {
  const tracedRuns = (message.toolRuns ?? []).filter(
    (run) => run.modelTrace !== null && run.modelTrace !== undefined,
  );
  if (message.role === "user" || tracedRuns.length === 0) {
    const body =
      message.role === "assistant" && message.body === ""
        ? STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER
        : message.body;
    return [{ role: message.role, content: body }];
  }
  const textParts =
    message.body === ""
      ? []
      : ([{ type: "text" as const, text: message.body }] as const);
  const toolCalls = tracedRuns.map((run) => ({
    type: "tool-call" as const,
    toolCallId: run.toolCallId,
    toolName: staffAssistantToolSetKey(run),
    input: {},
  }));
  const toolResults = tracedRuns.map((run) => ({
    type: "tool-result" as const,
    toolCallId: run.toolCallId,
    toolName: staffAssistantToolSetKey(run),
    output: staffAssistantToolResultOutput(run.modelTrace),
  }));
  return [
    { role: "assistant", content: [...textParts, ...toolCalls] },
    { role: "tool", content: toolResults },
  ];
}

/**
 * Anthropic rejects `tool_use` / `tool_result` blocks on a request that
 * defines no tools, and the intent gate attaches none on a chitchat turn
 * (`gatePolicy.kind === "none"`). Flatten reconstructed tool parts back to
 * text-only history so «дякую» after a tool turn is not a 400. Applied by
 * `streamStaffAssistantChat` whenever the ToolSet is empty — the caller
 * never has to know the model history carries tool parts.
 */
export function stripStaffAssistantToolParts(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const flattened: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }
    if (message.role !== "assistant" || typeof message.content === "string") {
      flattened.push(message);
      continue;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    flattened.push({
      role: "assistant",
      content:
        text === ""
          ? STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER
          : text,
    });
  }
  return applyStaffAssistantHistoryWindow(flattened);
}

/**
 * Drop client-supplied system messages. The mount always uses
 * `staffAssistantSystemPrompt` instead. Kept for protocol-envelope
 * tests; HTTP model history uses persisted rows.
 */
export function staffAssistantModelMessages(
  messages: readonly StaffAssistantChatMessage[],
): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    const text = textFromParts(message.parts);
    if (text === "") {
      if (message.role === "assistant") {
        modelMessages.push({
          role: "assistant",
          content: STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER,
        });
      }
      continue;
    }
    modelMessages.push({ role: message.role, content: text });
  }
  return applyStaffAssistantHistoryWindow(modelMessages);
}

function withHistoryCacheBreakpoint(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      ...STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
    },
  };
}

/**
 * Keep the last 8 user/assistant text turns. Tool messages stay attached
 * to the assistant turn that produced them so reconstructed
 * tool-call/result pairs remain valid. Cache the last completed history
 * message (assistant or tool) so the growing prefix can hit within the
 * 5-minute TTL. The newest user turn is never a cache breakpoint. A
 * breakpoint is not a cache-hit guarantee — sliding windows and digest
 * conversion change prefixes.
 */
export function applyStaffAssistantHistoryWindow(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const windowed = windowKeepingToolPairs(
    messages,
    STAFF_ASSISTANT_MODEL_HISTORY_MAX,
  );
  if (windowed.length < 2) {
    return windowed;
  }
  const last = windowed.at(-1);
  const prefixIndex = windowed.length - 2;
  const prefix = windowed[prefixIndex];
  if (
    last === undefined ||
    last.role !== "user" ||
    prefix === undefined ||
    (prefix.role !== "assistant" && prefix.role !== "tool")
  ) {
    return windowed;
  }
  windowed[prefixIndex] = withHistoryCacheBreakpoint(prefix);
  return windowed;
}

function windowKeepingToolPairs(
  messages: readonly ModelMessage[],
  maxTextTurns: number,
): ModelMessage[] {
  let textTurns = 0;
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      textTurns += 1;
    }
  }
  if (textTurns <= maxTextTurns) {
    return [...messages];
  }
  let seen = 0;
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      seen += 1;
      if (seen === maxTextTurns) {
        start = index;
        break;
      }
    }
  }
  return messages.slice(start);
}

function modelContentChars(content: ModelMessage["content"]): number {
  if (typeof content === "string") {
    return content.length;
  }
  let chars = 0;
  for (const part of content) {
    if (part.type === "text") {
      chars += part.text.length;
    }
  }
  return chars;
}

function modelTraceChars(content: ModelMessage["content"]): number {
  if (typeof content === "string") {
    return 0;
  }
  let chars = 0;
  for (const part of content) {
    if (part.type === "tool-result") {
      chars += staffAssistantToolResultChars(part.output);
    }
  }
  return chars;
}

/** Count and character length of model messages (text parts and traces). */
export function staffAssistantHistoryStats(messages: readonly ModelMessage[]): {
  readonly messageCount: number;
  readonly chars: number;
  readonly traceChars: number;
} {
  let chars = 0;
  let traceChars = 0;
  for (const message of messages) {
    chars += modelContentChars(message.content);
    traceChars += modelTraceChars(message.content);
  }
  return { messageCount: messages.length, chars, traceChars };
}

/**
 * HITL paused context: the action the human confirmed and the tool-call
 * id of that logical attempt. Used to pin `idempotencyKey` on resume;
 * tracing still uses the provider `toolCallId`.
 */
export interface PausedToolAttempt {
  readonly actionName: string;
  readonly toolCallId: string;
}

export type PausedToolAttemptResolution =
  | { readonly status: "ok"; readonly attempt: PausedToolAttempt }
  | { readonly status: "missing" }
  | { readonly status: "mismatch" };

/**
 * Client envelope: matching `data-confirmation` part (core.md §7).
 */
export function pausedToolAttemptForChallenge(
  messages: readonly StaffAssistantChatMessage[],
  challengeId: string,
): PausedToolAttempt | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      const confirmation = confirmationFromChatPart(part);
      if (confirmation?.challengeId === challengeId) {
        return {
          actionName: confirmation.actionName,
          toolCallId: confirmation.toolCallId,
        };
      }
    }
  }
  return undefined;
}

export interface StaffAssistantToolRunRef {
  readonly actionName: string;
  readonly toolCallId: string;
  readonly challengeId: string | null;
  readonly outcome: string;
}

/**
 * Server-authoritative paused attempt from `assistant.getConversation`
 * tool-run rows.
 */
export function pausedToolAttemptFromToolRuns(
  toolRuns: readonly StaffAssistantToolRunRef[],
  challengeId: string,
): PausedToolAttempt | undefined {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const run = toolRuns[index];
    if (
      run !== undefined &&
      run.outcome === "confirmation_required" &&
      run.challengeId === challengeId
    ) {
      return {
        actionName: run.actionName,
        toolCallId: run.toolCallId,
      };
    }
  }
  return undefined;
}

/**
 * Resume uses persisted rows when present, the client envelope when the
 * card streamed before persist finished, and rejects a forged/stale
 * envelope that disagrees with the server.
 */
export function resolvePausedToolAttempt(
  persisted: PausedToolAttempt | undefined,
  client: PausedToolAttempt | undefined,
): PausedToolAttemptResolution {
  if (persisted !== undefined && client !== undefined) {
    if (
      persisted.actionName !== client.actionName ||
      persisted.toolCallId !== client.toolCallId
    ) {
      return { status: "mismatch" };
    }
    return { status: "ok", attempt: persisted };
  }
  if (persisted !== undefined) {
    return { status: "ok", attempt: persisted };
  }
  if (client !== undefined) {
    return { status: "ok", attempt: client };
  }
  return { status: "missing" };
}
