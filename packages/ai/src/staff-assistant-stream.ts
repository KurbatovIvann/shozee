import type { ActionContract } from "@showzy/core/contract";
import { ConfirmationRequiredError, CoreError } from "@showzy/core/errors";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  Output,
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
  pickStaffAssistantForcedTool,
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  type ActionToolExecute,
} from "./action-tool.js";
import type { StaffAssistantForcedToolName } from "./gate.js";
import {
  isStaffAssistantConfirmationOutput,
  type StaffAssistantConfirmationOutput,
} from "./confirmation.js";
import { STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS } from "./anthropic-options.js";
import { clipStaffAssistantToolResult } from "./clip-tool-result.js";
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
import { staffAssistantJsonChars } from "./json-chars.js";
import { staffAssistantHistoryStats } from "./messages.js";
import {
  staffAssistantPersistedTurnText,
  staffAssistantTurnUsesCompletedPresenter,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  type StaffAssistantLocale,
  type StaffAssistantPresentedToolResult,
} from "./presenter.js";
import {
  createSpokenReplyUiTransform,
  isStaffAssistantSyntheticJsonTool,
  isStaffAssistantTypedToolError,
  lastStaffAssistantTypedToolErrorMessage,
  staffAssistantSpokenOutputSchema,
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
export const STAFF_ASSISTANT_TOOL_CALL_ID_MAX = 128;
/**
 * Mechanical cap so a looping model cannot run unbounded tool steps.
 * Structured `{ spoken }` output is an extra step after tools (SHO-386).
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
}

export type StaffAssistantUIMessage = UIMessage<
  unknown,
  {
    confirmation: StaffAssistantConfirmationOutput;
    choice: StaffAssistantChoiceCardEnvelope;
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

/**
 * Forced-job lifecycle: stop after a completed view, `needs_choice`, or
 * `confirmation_required`. A typed tool `{ status: "error" }` is not
 * terminal — the model gets one `toolChoice: "none"` speech step, then
 * this becomes true once that step has no domain tool result (SHO-429).
 */
function domainToolResults(
  step: StepResult<ToolSet>,
): ReadonlyArray<{ readonly toolName: string; readonly output: unknown }> {
  return step.toolResults.filter(
    (result) => !isStaffAssistantSyntheticJsonTool(result.toolName),
  );
}

function isForcedJobTerminalOutput(output: unknown): boolean {
  return !isStaffAssistantTypedToolError(output);
}

function stepReachedForcedJobTerminal(
  steps: Array<StepResult<ToolSet>>,
): boolean {
  const last = steps.at(-1);
  if (last === undefined) {
    return false;
  }
  const lastDomain = domainToolResults(last);
  if (lastDomain.some((result) => isForcedJobTerminalOutput(result.output))) {
    return true;
  }
  if (lastDomain.length > 0) {
    return false;
  }
  return steps.some((step) =>
    domainToolResults(step).some((result) =>
      isStaffAssistantTypedToolError(result.output),
    ),
  );
}

function domainToolRuns(
  runs: readonly StaffAssistantToolRun[],
): StaffAssistantToolRun[] {
  return runs.filter(
    (run) => !isStaffAssistantSyntheticJsonTool(run.actionName),
  );
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
    const toolCallId = clipToolCallId(options.toolCallId);
    if (runs.length >= STAFF_ASSISTANT_TOOL_RUNS_MAX) {
      return {
        status: "error",
        code: "INTERNAL",
        message: "The assistant could not complete this turn.",
      };
    }
    try {
      const output: unknown = await execute(actionName, input, {
        toolCallId,
      });
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
        message: "The assistant could not complete this turn.",
      };
    }
  };
}

/**
 * Clip the Tool execute return (after named façades map a compact view)
 * so catalog list prices are not stripped because images bloated the
 * executeAction payload. Persistence still records the registry output.
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
        presented.push({ toolName: name, output: returned });
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

const STAFF_ASSISTANT_PRESENTER_STREAM_TEXT_ID = "presenter";
const STAFF_ASSISTANT_TOOL_ERROR_STREAM_TEXT_ID = "tool-error";

function isStaffAssistantTextStreamPartType(type: string): boolean {
  return type === "text-start" || type === "text-delta" || type === "text-end";
}

/**
 * Drop model `{ spoken }` text parts when a registered completed surface
 * will replace the live bubble. Tool parts keep streaming.
 */
function createSuppressCompletedPresenterTextTransform<
  T extends { readonly type: string },
>(shouldSuppress: () => boolean): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(part, controller) {
      if (shouldSuppress() && isStaffAssistantTextStreamPartType(part.type)) {
        return;
      }
      controller.enqueue(part);
    },
  });
}

function createRecordVisibleTextTransform<
  T extends {
    readonly type: string;
    readonly delta?: unknown;
    readonly text?: unknown;
  },
>(seen: { chars: number }): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(part, controller) {
      if (part.type === "text-delta") {
        if (typeof part.delta === "string") {
          seen.chars += part.delta.length;
        } else if (typeof part.text === "string") {
          seen.chars += part.text.length;
        }
      }
      controller.enqueue(part);
    },
  });
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

/**
 * High-confidence job intents attach one ToolSet key with
 * `toolChoice: "required"`. A missing key is a wrong narrow set — fail-open
 * to the permission-filtered catalog (same as `other`) and do not force.
 */
function staffAssistantStreamTools(
  catalog: ToolSet,
  forcedToolName: StaffAssistantForcedToolName | undefined,
): { readonly tools: ToolSet; readonly forceJobTool: boolean } {
  if (forcedToolName === undefined) {
    return { tools: catalog, forceJobTool: false };
  }
  const pickedForced = pickStaffAssistantForcedTool(catalog, forcedToolName);
  if (pickedForced[forcedToolName] === undefined) {
    return { tools: catalog, forceJobTool: false };
  }
  return { tools: pickedForced, forceJobTool: true };
}

/**
 * AI SDK 7 staff-panel loop (ADR-0032). `execute` is injected so this
 * package never calls `/rpc`. ConfirmationRequiredError pauses the loop
 * and is streamed as a `data-confirmation` part (redacted summary only).
 * The Redis challenge remains core.md §7 — this does not auto-confirm.
 * When a registered completed surface exists, SSE `text-*` parts are the
 * presenter string (same as persist), not model `{ spoken }`.
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
   * High-confidence job intent (SHO-404): attach only this ToolSet key
   * and `toolChoice: "required"`. When the key is absent from the
   * permission-filtered catalog, fail-open to the full catalog (same as
   * `other`) and do not force `toolChoice: "required"`. Omit for today's
   * hot set + BM25.
   */
  readonly forcedToolName?: StaffAssistantForcedToolName;
  /**
   * Tenant bind for a user-turn ChoiceCard. Canonical input stays
   * server-side; the stream only writes the envelope.
   */
  readonly choiceBind?: ChoiceBind;
  readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
  readonly mintChoiceId?: () => string;
  /** Awaited inside the UI-message stream after `result.text`. A throw fails the stream. */
  readonly onTurn?: (turn: StaffAssistantTurnResult) => Promise<void>;
}): {
  readonly response: Response;
  readonly completion: Promise<StaffAssistantTurnResult>;
} {
  const runs: StaffAssistantToolRun[] = [];
  const presentedToolResults: StaffAssistantPresentedToolResult[] = [];
  const clipBytes: ClipByteMeter = { in: 0, out: 0 };
  const history = staffAssistantHistoryStats(options.messages);
  const locale = options.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
  const catalog = staffAssistantTools(
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
  const { tools, forceJobTool } = staffAssistantStreamTools(
    catalog,
    options.forcedToolName,
  );
  clipToolExecutes(tools, clipBytes, presentedToolResults);
  const toolsetHash = staffAssistantToolsetHash(Object.keys(tools));

  let resolveCompletion!: (value: StaffAssistantTurnResult) => void;
  const completion = new Promise<StaffAssistantTurnResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const stream = createUIMessageStream<StaffAssistantUIMessage>({
    execute: async ({ writer }) => {
      const result = streamText({
        model: options.model,
        system: staffAssistantSystemMessages(
          options.turnContextAddendum !== undefined &&
            options.turnContextAddendum !== ""
            ? options.turnContextAddendum
            : staffAssistantTurnContextAddendum({ now: new Date() }),
        ),
        messages: options.messages,
        tools,
        ...(forceJobTool ? { toolChoice: "required" as const } : {}),
        output: Output.object({ schema: staffAssistantSpokenOutputSchema }),
        providerOptions: {
          anthropic: STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS,
        },
        ...(options.abortSignal !== undefined
          ? { abortSignal: options.abortSignal }
          : {}),
        prepareStep: ({ steps }) => {
          if (!forceJobTool) {
            return undefined;
          }
          if (stepReachedForcedJobTerminal(steps)) {
            return { toolChoice: "none" as const };
          }
          if (steps.length === 0) {
            return { toolChoice: "required" as const };
          }
          return { toolChoice: "none" as const };
        },
        stopWhen: [
          ({ steps }) => steps.length >= STAFF_ASSISTANT_MAX_STEPS,
          ({ steps }) => stepRequestedConfirmation(steps),
          ({ steps }) => stepRequestedChoice(steps),
          ({ steps }) => forceJobTool && stepReachedForcedJobTerminal(steps),
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
      const visibleText = { chars: 0 };
      await writeUiMessageChunks(
        writer,
        toUIMessageStream({
          stream: result.stream
            .pipeThrough(
              createSpokenReplyUiTransform({
                runs,
                toolErrorMessage: () =>
                  lastStaffAssistantTypedToolErrorMessage(
                    presentedToolResults.map((item) => item.output),
                  ),
              }),
            )
            .pipeThrough(
              createSuppressCompletedPresenterTextTransform(() =>
                staffAssistantTurnUsesCompletedPresenter({
                  locale,
                  toolResults: presentedToolResults,
                  runs,
                }),
              ),
            )
            .pipeThrough(createRecordVisibleTextTransform(visibleText)),
          tools,
        }),
      );
      let parsedSpoken: string | undefined;
      try {
        parsedSpoken = (await result.output).spoken;
      } catch {
        parsedSpoken = undefined;
      }
      let rawText: string;
      try {
        rawText = await result.text;
      } catch {
        rawText = "The assistant could not complete this turn.";
      }
      const turn: StaffAssistantTurnResult = {
        text: staffAssistantPersistedTurnText({
          locale,
          toolResults: presentedToolResults,
          parsedSpoken,
          rawText,
          runs,
        }),
        toolRuns: domainToolRuns(runs).slice(0, STAFF_ASSISTANT_TOOL_RUNS_MAX),
        usage: await staffAssistantTurnUsageFromTotal(result.usage),
        toolsAttached: Object.keys(tools).length > 0,
        modelSteps: await staffAssistantModelStepCount(result.steps),
        toolResultBytesIn: clipBytes.in,
        toolResultBytesOut: clipBytes.out,
        toolsetHash,
        historyMessageCount: history.messageCount,
        historyChars: history.chars,
      };
      if (
        staffAssistantTurnUsesCompletedPresenter({
          locale,
          toolResults: presentedToolResults,
          runs,
        })
      ) {
        const id = STAFF_ASSISTANT_PRESENTER_STREAM_TEXT_ID;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: turn.text });
        writer.write({ type: "text-end", id });
      } else if (
        domainToolRuns(runs).length > 0 &&
        turn.text.trim() !== "" &&
        visibleText.chars === 0
      ) {
        const id = STAFF_ASSISTANT_TOOL_ERROR_STREAM_TEXT_ID;
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: turn.text });
        writer.write({ type: "text-end", id });
      }
      resolveCompletion(turn);
      if (options.onTurn !== undefined) {
        await options.onTurn(turn);
      }
    },
    onError: () => "The assistant could not complete this turn.",
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
