import type { ActionContract } from "@showzy/core/contract";
import { ConfirmationRequiredError, CoreError } from "@showzy/core/errors";
import {
  staffAssistantPresentationEnvelopesFromToolResults,
  type AssistantSurfaceToolResult,
  type StaffAssistantPresentationEnvelope,
} from "@showzy/validation/assistant-surfaces";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  type ActionToolExecute,
} from "./action-tool.js";
import {
  isStaffAssistantConfirmationOutput,
  type StaffAssistantConfirmationOutput,
} from "./confirmation.js";
import { STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS } from "./anthropic-options.js";
import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "./clip-tool-result.js";
import {
  choiceCardEnvelope,
  isStaffAssistantNeedsChoiceOutput,
  needsChoiceFromOrdersCreateConflict,
  staffAssistantTypedDomainErrorOutput,
  toolOutputRequestsChoice,
  type ChoiceBind,
  type ChoiceRecord,
  type StaffAssistantChoiceCardEnvelope,
} from "./choice.js";
import {
  staffAssistantJsonChars,
  staffAssistantPostgresJsonbTextChars,
} from "./json-chars.js";
import {
  staffAssistantHistoryStats,
  stripStaffAssistantToolParts,
} from "./messages.js";
import {
  staffAssistantPersistedTurnText,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  type StaffAssistantLocale,
  type StaffAssistantPresentedToolResult,
} from "./presenter.js";
import {
  createHoldCandidateReplyTextTransform,
  isStaffAssistantTypedToolError,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
  staffAssistantSpokenFallbackLocale,
} from "./spoken-reply.js";
import { staffAssistantSystemMessages } from "./system-prompt.js";
import { staffAssistantToolsetHash } from "./toolset-hash.js";
import { staffAssistantTurnContextAddendum } from "./turn-context.js";
import {
  staffAssistantTurnUsageFromTotal,
  type StaffAssistantTurnUsage,
} from "./usage.js";

export const STAFF_ASSISTANT_TOOL_RUNS_MAX = 50;
export const STAFF_ASSISTANT_RESULT_IDS_MAX = 50;
/** Persistence budget for `toolRuns` / executeAction — not envelope wire identity. */
export const STAFF_ASSISTANT_TOOL_CALL_ID_MAX = 128;
/**
 * Mechanical cap so a looping model cannot run unbounded tool steps.
 * Reply text is plain (SHO-507); structured output is not an extra step.
 */
export const STAFF_ASSISTANT_MAX_STEPS = 9;

const uuidSchema = z.uuid();

const RESULT_ID_KEYS = [
  "id",
  "orderId",
  "customerId",
  "documentId",
  "conversationId",
  "messageId",
  "requestId",
  "fileId",
] as const;

export type StaffAssistantToolRunOutcome =
  "success" | "error" | "confirmation_required" | "choice_required";

export interface StaffAssistantToolRun {
  readonly actionName: string;
  readonly toolCallId: string;
  readonly challengeId?: string;
  readonly resultIds: readonly string[];
  readonly outcome: StaffAssistantToolRunOutcome;
  /** Live ToolSet key from `clipToolExecutes` (`orders_list_page`). */
  readonly toolName?: string;
  readonly modelTrace?: unknown;
}

export interface StaffAssistantTurnResult {
  readonly text: string;
  readonly toolRuns: readonly StaffAssistantToolRun[];
  readonly usage: StaffAssistantTurnUsage;
  readonly toolsAttached: boolean;
  readonly modelSteps: number;
  readonly toolResultBytesIn: number;
  readonly toolResultBytesOut: number;
  readonly toolsetHash: string;
  readonly historyMessageCount: number;
  readonly historyChars: number;
  readonly historyTraceChars: number;
}

export type StaffAssistantUIMessage = UIMessage<
  unknown,
  {
    confirmation: StaffAssistantConfirmationOutput;
    choice: StaffAssistantChoiceCardEnvelope;
    presentation: StaffAssistantPresentationEnvelope;
  }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractUuidResultIds(output: unknown): string[] {
  if (!isRecord(output)) {
    return [];
  }
  const ids: string[] = [];
  for (const key of RESULT_ID_KEYS) {
    const value = output[key];
    if (typeof value === "string" && uuidSchema.safeParse(value).success) {
      ids.push(value);
    }
    if (ids.length >= STAFF_ASSISTANT_RESULT_IDS_MAX) {
      break;
    }
  }
  return ids;
}

function clipToolCallId(toolCallId: string): string {
  return toolCallId.slice(0, STAFF_ASSISTANT_TOOL_CALL_ID_MAX);
}

function confirmationFromError(
  error: ConfirmationRequiredError,
  actionName: string,
  toolCallId: string,
): StaffAssistantConfirmationOutput {
  return {
    status: "confirmation_required",
    challengeId: error.challenge.challengeId,
    summary: error.challenge.summary,
    expiresAt: error.challenge.expiresAt,
    actionName,
    toolCallId,
  };
}

function stepRequestedConfirmation(steps: Array<StepResult<ToolSet>>): boolean {
  const last = steps.at(-1);
  if (last === undefined) {
    return false;
  }
  return last.toolResults.some((result) =>
    isStaffAssistantConfirmationOutput(result.output),
  );
}

function stepRequestedChoice(steps: Array<StepResult<ToolSet>>): boolean {
  const last = steps.at(-1);
  if (last === undefined) {
    return false;
  }
  return last.toolResults.some((result) =>
    toolOutputRequestsChoice(result.output),
  );
}

function attachClippedModelTraces(
  runs: readonly StaffAssistantToolRun[],
  presented: readonly StaffAssistantPresentedToolResult[],
): StaffAssistantToolRun[] {
  const traces = new Map<
    string,
    { readonly output: unknown; readonly toolName: string }
  >();
  for (const item of presented) {
    if (item.toolCallId !== undefined && item.toolCallId.length > 0) {
      traces.set(clipToolCallId(item.toolCallId), {
        output: item.output,
        toolName: item.toolName,
      });
    }
  }
  return runs.map((run) => {
    if (run.outcome !== "success") {
      return run;
    }
    const presentedRun = traces.get(run.toolCallId);
    if (presentedRun === undefined) {
      return run;
    }
    const modelTrace = presentedRun.output;
    if (
      isStaffAssistantConfirmationOutput(modelTrace) ||
      isStaffAssistantNeedsChoiceOutput(modelTrace) ||
      isStaffAssistantTypedToolError(modelTrace)
    ) {
      return run;
    }
    if (
      staffAssistantPostgresJsonbTextChars(modelTrace) >
      STAFF_ASSISTANT_CLIP_JSON_MAX
    ) {
      return run;
    }
    return { ...run, toolName: presentedRun.toolName, modelTrace };
  });
}

interface ClipByteMeter {
  in: number;
  out: number;
}

function meterToolResult(
  meter: ClipByteMeter,
  raw: unknown,
  returned: unknown,
): unknown {
  meter.in += staffAssistantJsonChars(raw);
  meter.out += staffAssistantJsonChars(returned);
  return returned;
}

function staffAssistantInternalToolErrorMessage(
  locale: StaffAssistantLocale,
): string {
  return STAFF_ASSISTANT_TOOL_ERROR_FALLBACK[
    staffAssistantSpokenFallbackLocale(locale)
  ];
}

function wrapExecute(
  execute: ActionToolExecute,
  runs: StaffAssistantToolRun[],
  hooks: {
    readonly locale: StaffAssistantLocale;
    readonly choiceBind?: ChoiceBind;
    readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
    readonly mintChoiceId?: () => string;
  },
): ActionToolExecute {
  return async (actionName, input, options) => {
    // Persistence / executeAction budget only. Envelope identity stays unclipped.
    const toolCallId = clipToolCallId(options.toolCallId);
    if (runs.length >= STAFF_ASSISTANT_TOOL_RUNS_MAX) {
      return {
        status: "error",
        code: "INTERNAL",
        message: staffAssistantInternalToolErrorMessage(hooks.locale),
      };
    }
    try {
      const output: unknown = await execute(actionName, input, {
        toolCallId,
      });
      // Registry name is executeAction identity (ADR-0033). Reconstructed
      // `toolName` / digest prefix come from clipToolExecutes' ToolSet key.
      runs.push({
        actionName,
        toolCallId,
        resultIds: extractUuidResultIds(output),
        outcome: "success",
      });
      return output;
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) {
        const confirmation = confirmationFromError(
          error,
          actionName,
          toolCallId,
        );
        runs.push({
          actionName,
          toolCallId,
          challengeId: confirmation.challengeId,
          resultIds: [],
          outcome: "confirmation_required",
        });
        return confirmation;
      }
      const needsChoice = await needsChoiceFromOrdersCreateConflict({
        actionName,
        input,
        error,
        locale: hooks.locale,
        ...(hooks.choiceBind !== undefined ? { bind: hooks.choiceBind } : {}),
        ...(hooks.openChoice !== undefined
          ? { openChoice: hooks.openChoice }
          : {}),
        ...(hooks.mintChoiceId !== undefined
          ? { mintChoiceId: hooks.mintChoiceId }
          : {}),
      });
      if (needsChoice !== undefined) {
        runs.push({
          actionName,
          toolCallId,
          challengeId: needsChoice.challengeId,
          resultIds: [],
          outcome: "choice_required",
        });
        return needsChoice;
      }
      if (error instanceof CoreError) {
        runs.push({
          actionName,
          toolCallId,
          resultIds: [],
          outcome: "error",
        });
        const domainError = staffAssistantTypedDomainErrorOutput(error);
        if (domainError !== undefined) {
          return domainError;
        }
        return {
          status: "error",
          code: error.code,
          message: error.clientMessage,
        };
      }
      runs.push({
        actionName,
        toolCallId,
        resultIds: [],
        outcome: "error",
      });
      return {
        status: "error",
        code: "INTERNAL",
        message: staffAssistantInternalToolErrorMessage(hooks.locale),
      };
    }
  };
}

/**
 * Clip the Tool execute return (after named façades map a compact view)
 * so catalog list prices are not stripped because images bloated the
 * executeAction payload. wrapExecute still records result ids from the
 * registry output. `model_trace` uses this clipped façade output.
 * Loop `name` is the live ToolSet key (`orders_list_page`); persist it
 * as `toolName` so reconstruction does not emit `orders.list`.
 */
function clipToolExecutes(
  tools: ToolSet,
  clipBytes: ClipByteMeter,
  presented: StaffAssistantPresentedToolResult[],
): void {
  for (const name of Object.keys(tools)) {
    if (name === STAFF_ASSISTANT_TOOL_SEARCH_NAME) {
      continue;
    }
    const aiTool = tools[name];
    if (aiTool === undefined || aiTool.execute === undefined) {
      continue;
    }
    const inner = aiTool.execute;
    tools[name] = {
      ...aiTool,
      execute: async (input, options) => {
        const output: unknown = await inner(input, options);
        const returned = meterToolResult(
          clipBytes,
          output,
          clipStaffAssistantToolResult(output),
        );
        // Envelope `toolCallIds` must match the unclipped id the UI
        // stream carries on the tool part. The 128-char clip is a
        // persistence budget for `toolRuns` / executeAction, not wire
        // identity (SHO-463).
        const toolCallId =
          typeof options.toolCallId === "string" &&
          options.toolCallId.length > 0
            ? options.toolCallId
            : undefined;
        if (toolCallId === undefined) {
          presented.push({ toolName: name, output: returned });
        } else {
          presented.push({
            toolName: name,
            output: returned,
            toolCallId,
          });
        }
        return returned;
      },
    };
  }
}

async function staffAssistantModelStepCount(
  steps: PromiseLike<unknown>,
): Promise<number> {
  try {
    const value = await steps;
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

const STAFF_ASSISTANT_REPLY_STREAM_TEXT_ID = "reply";

function presentedAsSurfaceToolResults(
  presented: readonly StaffAssistantPresentedToolResult[],
): AssistantSurfaceToolResult[] {
  return presented.map((item) => {
    if (typeof item.toolCallId === "string" && item.toolCallId.length > 0) {
      return {
        toolName: item.toolName,
        output: item.output,
        toolCallId: item.toolCallId,
      };
    }
    return { toolName: item.toolName, output: item.output };
  });
}

function turnHasHitlPause(runs: readonly StaffAssistantToolRun[]): boolean {
  return runs.some(
    (run) =>
      run.outcome === "confirmation_required" ||
      run.outcome === "choice_required",
  );
}

/**
 * Live-turn only: names the surface presenter already chose. Never
 * persisted on `assistant_tool_runs` (ADR-0011). HITL confirmation and
 * choice turns emit their own envelopes and no presentation part.
 */
function writePresentationEnvelopes(
  writer: {
    write: (part: {
      type: "data-presentation";
      data: StaffAssistantPresentationEnvelope;
    }) => void;
  },
  presented: readonly StaffAssistantPresentedToolResult[],
  runs: readonly StaffAssistantToolRun[],
): void {
  if (turnHasHitlPause(runs)) {
    return;
  }
  const envelopes = staffAssistantPresentationEnvelopesFromToolResults(
    presentedAsSurfaceToolResults(presented),
  );
  for (const data of envelopes) {
    writer.write({ type: "data-presentation", data });
  }
}

async function writeUiMessageChunks<T>(
  writer: { write: (part: T) => void },
  stream: ReadableStream<T>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      writer.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function staffAssistantAbortError(): Error {
  const error = new Error("The assistant turn was aborted.");
  error.name = "AbortError";
  return error;
}

async function awaitUnlessAborted<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (abortSignal === undefined) {
    return promise;
  }
  if (abortSignal.aborted) {
    throw staffAssistantAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(staffAssistantAbortError());
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : staffAssistantAbortError());
      },
    );
  });
}

/**
 * AI SDK 7 staff-panel loop (ADR-0032). `execute` is injected so this
 * package never calls `/rpc`. ConfirmationRequiredError pauses the loop
 * and is streamed as a `data-confirmation` part (redacted summary only).
 * The Redis challenge remains core.md §7 — this does not auto-confirm.
 * Candidate reply text is buffered until presenter selection; SSE
 * `text-*` parts are that same finalized string as persist (SHO-507).
 */
export function streamStaffAssistantChat(options: {
  readonly model: LanguageModel;
  readonly messages: ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly abortSignal?: AbortSignal;
  readonly responseHeaders?: Record<string, string>;
  /**
   * Uncached second system message (clock always; company + working set
   * when the HTTP mount composed them). When omitted, a clock-only
   * addendum is generated for this turn.
   */
  readonly turnContextAddendum?: string;
  /**
   * Explicit presenter locale from the chat request. Legacy callers
   * omit this; default is Ukrainian.
   */
  readonly locale?: StaffAssistantLocale;
  /**
   * Tenant bind for a user-turn ChoiceCard. Canonical input stays
   * server-side; the stream only writes the envelope.
   */
  readonly choiceBind?: ChoiceBind;
  readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
  readonly mintChoiceId?: () => string;
  /** Awaited inside the UI-message stream after `result.text`. A throw fails the stream. */
  readonly onTurn?: (turn: StaffAssistantTurnResult) => Promise<void>;
  /**
   * Awaited when execute ends without a successful `onTurn` (model
   * error, abort, or `onTurn` throw). HTTP uses this to drop an unused
   * budget reservation.
   */
  readonly onAbandoned?: () => Promise<void>;
}): {
  readonly response: Response;
  readonly completion: Promise<StaffAssistantTurnResult>;
} {
  const runs: StaffAssistantToolRun[] = [];
  const presentedToolResults: StaffAssistantPresentedToolResult[] = [];
  const clipBytes: ClipByteMeter = { in: 0, out: 0 };
  const locale = options.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
  const tools = staffAssistantTools(
    options.contracts,
    wrapExecute(options.execute, runs, {
      locale,
      ...(options.choiceBind !== undefined
        ? { choiceBind: options.choiceBind }
        : {}),
      ...(options.openChoice !== undefined
        ? { openChoice: options.openChoice }
        : {}),
      ...(options.mintChoiceId !== undefined
        ? { mintChoiceId: options.mintChoiceId }
        : {}),
    }),
  );
  clipToolExecutes(tools, clipBytes, presentedToolResults);
  const toolsetHash = staffAssistantToolsetHash(Object.keys(tools));
  // A request with no tools cannot carry reconstructed tool-call/result
  // parts: Anthropic rejects `tool_use` / `tool_result` blocks unless
  // `tools` is defined, and the provider omits `tools` for an empty set.
  const messages =
    Object.keys(tools).length === 0
      ? stripStaffAssistantToolParts(options.messages)
      : options.messages;
  const history = staffAssistantHistoryStats(messages);

  let resolveCompletion!: (value: StaffAssistantTurnResult) => void;
  const completion = new Promise<StaffAssistantTurnResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const stream = createUIMessageStream<StaffAssistantUIMessage>({
    execute: async ({ writer }) => {
      let onTurnSettled = false;
      try {
        if (options.abortSignal?.aborted === true) {
          throw staffAssistantAbortError();
        }
        const result = streamText({
          model: options.model,
          system: staffAssistantSystemMessages(
            options.turnContextAddendum !== undefined &&
              options.turnContextAddendum !== ""
              ? options.turnContextAddendum
              : staffAssistantTurnContextAddendum({ now: new Date() }),
          ),
          messages,
          tools,
          providerOptions: {
            anthropic: STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS,
          },
          ...(options.abortSignal !== undefined
            ? { abortSignal: options.abortSignal }
            : {}),
          stopWhen: [
            ({ steps }) => steps.length >= STAFF_ASSISTANT_MAX_STEPS,
            ({ steps }) => stepRequestedConfirmation(steps),
            ({ steps }) => stepRequestedChoice(steps),
          ],
          onStepEnd: ({ toolResults }) => {
            for (const toolResult of toolResults) {
              if (isStaffAssistantConfirmationOutput(toolResult.output)) {
                writer.write({
                  type: "data-confirmation",
                  data: toolResult.output,
                });
              }
              if (isStaffAssistantNeedsChoiceOutput(toolResult.output)) {
                writer.write({
                  type: "data-choice",
                  data: choiceCardEnvelope({
                    challengeId: toolResult.output.challengeId,
                    status: "needs_choice",
                    reason: toolResult.output.reason,
                    ...(toolResult.output.choiceKind !== undefined
                      ? { choiceKind: toolResult.output.choiceKind }
                      : {}),
                    productName: toolResult.output.productName,
                    options: toolResult.output.options,
                    optionsTruncated: toolResult.output.optionsTruncated,
                  }),
                });
              }
            }
          },
        });
        await awaitUnlessAborted(
          writeUiMessageChunks(
            writer,
            toUIMessageStream({
              stream: result.stream.pipeThrough(
                createHoldCandidateReplyTextTransform(),
              ),
              tools,
            }),
          ),
          options.abortSignal,
        );
        let rawText: string;
        try {
          rawText = await result.text;
        } catch {
          // Empty so presenter / spoken lookup runs (SHO-514).
          rawText = "";
        }
        const turn: StaffAssistantTurnResult = {
          text: staffAssistantPersistedTurnText({
            locale,
            toolResults: presentedToolResults,
            rawText,
            runs,
          }),
          toolRuns: attachClippedModelTraces(
            runs.slice(0, STAFF_ASSISTANT_TOOL_RUNS_MAX),
            presentedToolResults,
          ),
          usage: await staffAssistantTurnUsageFromTotal(result.usage),
          toolsAttached: Object.keys(tools).length > 0,
          modelSteps: await staffAssistantModelStepCount(result.steps),
          toolResultBytesIn: clipBytes.in,
          toolResultBytesOut: clipBytes.out,
          toolsetHash,
          historyMessageCount: history.messageCount,
          historyChars: history.chars,
          historyTraceChars: history.traceChars,
        };
        writePresentationEnvelopes(writer, presentedToolResults, runs);
        if (turn.text.trim() !== "") {
          const id = STAFF_ASSISTANT_REPLY_STREAM_TEXT_ID;
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: turn.text });
          writer.write({ type: "text-end", id });
        }
        resolveCompletion(turn);
        if (options.onTurn !== undefined) {
          await options.onTurn(turn);
        }
        onTurnSettled = true;
      } finally {
        if (!onTurnSettled && options.onAbandoned !== undefined) {
          await options.onAbandoned();
        }
      }
    },
    onError: () =>
      STAFF_ASSISTANT_TOOL_ERROR_FALLBACK[
        staffAssistantSpokenFallbackLocale(locale)
      ],
  });

  return {
    response: createUIMessageStreamResponse({
      stream,
      ...(options.responseHeaders !== undefined
        ? { headers: options.responseHeaders }
        : {}),
    }),
    completion,
  };
}
