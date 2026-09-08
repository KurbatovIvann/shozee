/**
 * Staff-assistant host loop (ADR-0037 / SHO-520 / SHO-524).
 *
 * One `streamText` call. Live `POST /assistant/chat` wraps this loop.
 * Do not call the intent gate or a second speaker. Always attach the
 * permitted tool set plus BM25.
 */
import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";

import {
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  type ActionToolExecute,
} from "../action-tool.js";
import {
  toolOutputRequestsChoice,
  type ChoiceBind,
  type ChoiceRecord,
} from "../choice.js";
import { isStaffAssistantConfirmationOutput } from "../confirmation.js";
import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "../clip-tool-result.js";
import {
  createPendingReplaceTool,
  type PendingReplaceHostApply,
} from "../host-tools/pending-replace.js";
import {
  PENDING_REPLACE_TOOL_NAME,
  type PendingInteractionRecord,
} from "../pending.js";
import {
  staffAssistantJsonChars,
  staffAssistantPostgresJsonbTextChars,
} from "../json-chars.js";
import {
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  type StaffAssistantLocale,
} from "../locale.js";
import {
  STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER,
  staffAssistantHistoryStats,
  stripStaffAssistantToolParts,
} from "../messages.js";
import { staffAssistantToolResultOutput } from "../model-trace.js";
import { anthropicStaffProvider } from "../provider/anthropic.js";
import type { StaffProviderAdapter } from "../provider/types.js";
import {
  STAFF_ASSISTANT_MAX_STEPS,
  STAFF_ASSISTANT_TOOL_CALL_ID_MAX,
  STAFF_ASSISTANT_TOOL_RUNS_MAX,
  type StaffAssistantToolRun,
  type StaffAssistantTurnResult,
} from "../tool-run.js";
import { staffAssistantSystemMessages } from "../system-prompt.js";
import { staffAssistantToolsetHash } from "../toolset-hash.js";
import { staffAssistantTurnContextAddendum } from "../turn-context.js";
import type {
  StaffAssistantPresentedToolResult,
  StaffAssistantTurnRun,
} from "../turn-speech.js";
import { staffAssistantTurnUsageFromTotal } from "../usage.js";

import {
  emptyHostExecuteState,
  isHostHitlPausedOutput,
  wrapHostSequentialExecute,
  type StaffAssistantHostCheckpoint,
  type StaffAssistantHostExecuteState,
  type StaffAssistantHostPendingCheck,
} from "./execute.js";
import {
  commitHostSpeech,
  lastUsableHostModelText,
  usableHostModelText,
} from "./speech.js";

export type {
  StaffAssistantHostCheckpoint,
  StaffAssistantHostCheckpointFinishInput,
  StaffAssistantHostCheckpointStageInput,
  StaffAssistantHostPendingCheck,
  StaffAssistantHostPendingDecision,
} from "./execute.js";
export {
  allowHostPendingAlways,
  emptyHostExecuteState,
  refuseHostPendingOpen,
  HOST_HITL_PAUSED_OUTPUT,
  HOST_HITL_PAUSED_STATUS,
  isHostHitlPausedOutput,
} from "./execute.js";
export {
  commitHostSpeech,
  lastUsableHostModelText,
  usableHostModelText,
} from "./speech.js";

/** streamText step tool call as the model sent it (façade / provider input). */
export interface StaffAssistantHostModelToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface StaffAssistantHostTurnResult extends StaffAssistantTurnResult {
  readonly modelToolCalls: readonly StaffAssistantHostModelToolCall[];
}

interface ClipByteMeter {
  in: number;
  out: number;
}

function clipToolCallId(toolCallId: string): string {
  return toolCallId.slice(0, STAFF_ASSISTANT_TOOL_CALL_ID_MAX);
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

function clipToolExecutes(
  tools: ToolSet,
  clipBytes: ClipByteMeter,
  presented: StaffAssistantPresentedToolResult[],
  state: StaffAssistantHostExecuteState,
  checkpoint?: StaffAssistantHostCheckpoint,
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
      execute: (input, options) =>
        state.toolQueue.enqueue(async () => {
          const toolCallId =
            typeof options.toolCallId === "string" &&
            options.toolCallId.length > 0
              ? clipToolCallId(options.toolCallId)
              : undefined;
          if (toolCallId !== undefined) {
            state.facadeByToolCallId.set(toolCallId, {
              toolName: name,
              toolInput: input,
            });
          }
          const output: unknown = await inner(input, options);
          if (isHostHitlPausedOutput(output)) {
            return output;
          }
          const returned = meterToolResult(
            clipBytes,
            output,
            clipStaffAssistantToolResult(output),
          );
          if (toolCallId === undefined) {
            presented.push({ toolName: name, output: returned });
          } else {
            presented.push({
              toolName: name,
              output: returned,
              toolCallId,
            });
          }
          if (checkpoint !== undefined && toolCallId !== undefined) {
            const executionId = state.executionIdByToolCallId.get(toolCallId);
            const run = state.runs.find(
              (item) => item.toolCallId === toolCallId,
            );
            if (executionId !== undefined && run !== undefined) {
              await checkpoint.finishRun({
                executionId,
                outcome: run.outcome,
                modelTrace: returned,
                resultIds: run.resultIds,
                ...(run.challengeId !== undefined
                  ? { challengeId: run.challengeId }
                  : {}),
              });
            }
          }
          return returned;
        }),
    };
  }
}

function stepHasHitl(step: StepResult<ToolSet>): boolean {
  return step.toolResults.some(
    (result) =>
      isStaffAssistantConfirmationOutput(result.output) ||
      toolOutputRequestsChoice(result.output),
  );
}

function hostShouldStopAfterHitl(steps: Array<StepResult<ToolSet>>): boolean {
  const hitlIndex = steps.findIndex(stepHasHitl);
  if (hitlIndex === -1) {
    return false;
  }
  const extra = steps.length - 1 - hitlIndex;
  if (extra >= 1) {
    return true;
  }
  const last = steps[hitlIndex];
  if (last === undefined) {
    return false;
  }
  return usableHostModelText(last.text) !== undefined;
}

function hostModelToolCallsFromSteps(
  steps: readonly StepResult<ToolSet>[],
): StaffAssistantHostModelToolCall[] {
  const calls: StaffAssistantHostModelToolCall[] = [];
  for (const step of steps) {
    const pausedToolCallIds = new Set<string>();
    for (const result of step.toolResults) {
      if (isHostHitlPausedOutput(result.output)) {
        pausedToolCallIds.add(result.toolCallId);
      }
    }
    for (const call of step.toolCalls) {
      if (pausedToolCallIds.has(call.toolCallId)) {
        continue;
      }
      calls.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }
  }
  return calls;
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
    const presentedRun = traces.get(run.toolCallId);
    if (presentedRun === undefined) {
      return run;
    }
    const modelTrace = presentedRun.output;
    if (
      staffAssistantPostgresJsonbTextChars(modelTrace) >
      STAFF_ASSISTANT_CLIP_JSON_MAX
    ) {
      return run;
    }
    return { ...run, toolName: presentedRun.toolName, modelTrace };
  });
}

/**
 * A persisted `started` tool-run to replay before the next model step.
 * Identity is `executionId`, not a model-regenerated `toolCallId`.
 */
export interface StaffAssistantHostStartedRun {
  readonly messageId: string;
  readonly executionId: string;
  readonly seq: number;
  readonly actionName: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInput: unknown;
}

/**
 * Host-minted Phase A attempt (`begin:phase-a:${pendingId}`). Chat
 * recovery must not execute these rows on a later assistant message.
 */
export const HOST_PHASE_A_TOOL_CALL_ID_PREFIX = "phase-a:" as const;

/**
 * Host-minted choice / successor HITL seed (`begin:successor:` /
 * `choice:${pendingId}`). Same exclusion as Phase A.
 */
export const HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX = "choice:" as const;

export function isHostSeededHitlToolCallId(toolCallId: string): boolean {
  return (
    toolCallId.startsWith(HOST_PHASE_A_TOOL_CALL_ID_PREFIX) ||
    toolCallId.startsWith(HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX)
  );
}

function compareStartedRunSeq(
  left: StaffAssistantHostStartedRun,
  right: StaffAssistantHostStartedRun,
): number {
  return left.seq - right.seq;
}

/**
 * Chat-turn `started` rows, including those whose assistant message is
 * not the current `begin()` id. A new user line mints a new assistant
 * replica; crash recovery still replays the stored `executionId`.
 * Host-seeded HITL / Phase A ids stay on their own resume path.
 */
function chatRecoverableStartedRuns(
  runs: readonly StaffAssistantHostStartedRun[],
): StaffAssistantHostStartedRun[] {
  const chatTurn = runs.filter(
    (run) => !isHostSeededHitlToolCallId(run.toolCallId),
  );
  const messageOrder: string[] = [];
  const byMessage = new Map<string, StaffAssistantHostStartedRun[]>();
  for (const run of chatTurn) {
    const existing = byMessage.get(run.messageId);
    if (existing === undefined) {
      messageOrder.push(run.messageId);
      byMessage.set(run.messageId, [run]);
    } else {
      existing.push(run);
    }
  }
  return messageOrder.flatMap((messageId) => {
    const group = byMessage.get(messageId);
    if (group === undefined) {
      return [];
    }
    return group.slice().sort(compareStartedRunSeq);
  });
}

async function recoverStartedToolRuns(options: {
  readonly tools: ToolSet;
  readonly state: StaffAssistantHostExecuteState;
  readonly messageId: string | undefined;
  readonly runs: readonly StaffAssistantHostStartedRun[];
}): Promise<StaffAssistantHostStartedRun[]> {
  if (options.messageId === undefined || options.runs.length === 0) {
    return [];
  }
  const recoverable = chatRecoverableStartedRuns(options.runs);
  if (recoverable.length === 0) {
    return [];
  }
  for (const run of recoverable) {
    options.state.executionIdByToolCallId.set(run.toolCallId, run.executionId);
    options.state.facadeByToolCallId.set(run.toolCallId, {
      toolName: run.toolName,
      toolInput: run.toolInput,
    });
    const tool = options.tools[run.toolName];
    const executeTool = tool?.execute;
    if (executeTool === undefined) {
      throw new CoreInvariantError(
        `cannot recover staged tool "${run.toolName}"`,
      );
    }
    await executeTool(run.toolInput, {
      toolCallId: run.toolCallId,
      messages: [],
      context: undefined,
    });
  }
  let maxSeqOnCurrent = -1;
  for (const run of recoverable) {
    if (run.messageId === options.messageId && run.seq > maxSeqOnCurrent) {
      maxSeqOnCurrent = run.seq;
    }
  }
  if (maxSeqOnCurrent >= 0) {
    options.state.seq = maxSeqOnCurrent + 1;
  }
  return recoverable;
}

function assistantMessageWithStartedCalls(
  message: ModelMessage,
  recovered: readonly StaffAssistantHostStartedRun[],
): ModelMessage {
  if (message.role !== "assistant") {
    return message;
  }
  const existingIds = new Set<string>();
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "tool-call") {
        existingIds.add(part.toolCallId);
      }
    }
  }
  const missingCalls = recovered
    .filter((run) => !existingIds.has(run.toolCallId))
    .map((run) => ({
      type: "tool-call" as const,
      toolCallId: run.toolCallId,
      toolName: run.toolName,
      input: run.toolInput ?? {},
    }));
  if (missingCalls.length === 0 && Array.isArray(message.content)) {
    return message;
  }
  if (typeof message.content === "string") {
    const keepText =
      message.content !== "" &&
      message.content !== STAFF_ASSISTANT_EMPTY_ASSISTANT_HISTORY_PLACEHOLDER;
    return {
      ...message,
      content: [
        ...(keepText
          ? ([{ type: "text" as const, text: message.content }] as const)
          : []),
        ...missingCalls,
      ],
    };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, ...missingCalls] };
  }
  return message;
}

function mergeRecoveredToolResultsIntoHistory(
  messages: readonly ModelMessage[],
  recovered: readonly StaffAssistantHostStartedRun[],
  presented: readonly StaffAssistantPresentedToolResult[],
): ModelMessage[] {
  if (recovered.length === 0) {
    return [...messages];
  }
  const presentedByCallId = new Map<
    string,
    StaffAssistantPresentedToolResult
  >();
  for (const item of presented) {
    if (item.toolCallId !== undefined && item.toolCallId.length > 0) {
      presentedByCallId.set(item.toolCallId, item);
    }
  }
  const replacements = new Map<
    string,
    {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly output: ReturnType<typeof staffAssistantToolResultOutput>;
    }
  >();
  for (const run of recovered) {
    const presentedRun = presentedByCallId.get(run.toolCallId);
    if (presentedRun === undefined) {
      continue;
    }
    replacements.set(run.toolCallId, {
      type: "tool-result",
      toolCallId: run.toolCallId,
      toolName: run.toolName,
      output: staffAssistantToolResultOutput(presentedRun.output),
    });
  }
  if (replacements.size === 0) {
    return [...messages];
  }
  const replacedIds = new Set<string>();
  const next = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }
        const replacement = replacements.get(part.toolCallId);
        if (replacement === undefined) {
          return part;
        }
        replacedIds.add(part.toolCallId);
        return replacement;
      }),
    };
  });
  const missing = recovered.flatMap((run) => {
    const replacement = replacements.get(run.toolCallId);
    if (replacement === undefined || replacedIds.has(run.toolCallId)) {
      return [];
    }
    return [replacement];
  });
  if (missing.length === 0) {
    return next;
  }
  const last = next.at(-1);
  if (last?.role === "tool" && Array.isArray(last.content)) {
    return [
      ...next.slice(0, -1),
      { ...last, content: [...last.content, ...missing] },
    ];
  }
  if (last?.role === "assistant") {
    return [
      ...next.slice(0, -1),
      assistantMessageWithStartedCalls(last, recovered),
      { role: "tool", content: missing },
    ];
  }
  return next;
}

export interface StaffAssistantHostTurnOptions {
  readonly model: LanguageModel;
  readonly messages: ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly abortSignal?: AbortSignal;
  readonly turnContextAddendum?: string;
  readonly locale?: StaffAssistantLocale;
  readonly choiceBind?: ChoiceBind;
  readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
  readonly openPending?: (record: PendingInteractionRecord) => Promise<boolean>;
  readonly mintChoiceId?: () => string;
  readonly provider?: StaffProviderAdapter;
  readonly checkPending?: StaffAssistantHostPendingCheck;
  readonly checkpoint?: StaffAssistantHostCheckpoint;
  readonly pendingReplace?: PendingReplaceHostApply;
  /**
   * Tool runs already committed this job (Phase A write, prior
   * `streamText`). Generation fail after write still uses the success
   * speech fallback instead of the empty-turn fallback.
   */
  readonly priorRuns?: readonly StaffAssistantTurnRun[];
  /**
   * In-flight `started` rows for this conversation. The loop replays
   * execute + `finishRun` from stored `executionId` + `toolInput` even
   * when `begin()` minted a new assistant message — the model must not
   * re-decide that call (SHO-539). Host-seeded HITL / Phase A ids are
   * not recovered here.
   */
  readonly recoverStartedRuns?: readonly StaffAssistantHostStartedRun[];
}

/**
 * One `streamText` host turn. Live `POST /assistant/chat` wraps this
 * loop (SHO-524); unpublished `/assistant/host/chat` stays off production.
 */
export async function runStaffAssistantHostTurn(
  options: StaffAssistantHostTurnOptions,
): Promise<StaffAssistantHostTurnResult> {
  const state = emptyHostExecuteState();
  if (options.checkpoint !== undefined) {
    const begun = await options.checkpoint.begin();
    state.messageId = begun.messageId;
  }
  const presentedToolResults: StaffAssistantPresentedToolResult[] = [];
  const clipBytes: ClipByteMeter = { in: 0, out: 0 };
  const locale = options.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
  const provider = options.provider ?? anthropicStaffProvider;
  const tools = staffAssistantTools(
    options.contracts,
    wrapHostSequentialExecute(options.execute, state, {
      locale,
      ...(options.choiceBind !== undefined
        ? { choiceBind: options.choiceBind }
        : {}),
      ...(options.openChoice !== undefined
        ? { openChoice: options.openChoice }
        : {}),
      ...(options.openPending !== undefined
        ? { openPending: options.openPending }
        : {}),
      ...(options.mintChoiceId !== undefined
        ? { mintChoiceId: options.mintChoiceId }
        : {}),
      ...(options.checkPending !== undefined
        ? { checkPending: options.checkPending }
        : {}),
      enqueue: false,
      ...(options.checkpoint !== undefined
        ? { checkpoint: options.checkpoint }
        : {}),
    }),
    provider,
  );
  if (options.pendingReplace !== undefined) {
    tools[PENDING_REPLACE_TOOL_NAME] = createPendingReplaceTool(
      options.pendingReplace,
    );
  }
  clipToolExecutes(
    tools,
    clipBytes,
    presentedToolResults,
    state,
    options.checkpoint,
  );
  const recovered = await recoverStartedToolRuns({
    tools,
    state,
    messageId: state.messageId,
    runs: options.recoverStartedRuns ?? [],
  });
  const toolsetHash = staffAssistantToolsetHash(
    Object.keys(tools),
    provider.id,
  );
  let messages =
    Object.keys(tools).length === 0
      ? stripStaffAssistantToolParts(options.messages, provider)
      : options.messages;
  if (recovered.length > 0) {
    messages = mergeRecoveredToolResultsIntoHistory(
      messages,
      recovered,
      presentedToolResults,
    );
  }
  const history = staffAssistantHistoryStats(messages);

  const result = streamText({
    model: options.model,
    system: staffAssistantSystemMessages(
      options.turnContextAddendum !== undefined &&
        options.turnContextAddendum !== ""
        ? options.turnContextAddendum
        : staffAssistantTurnContextAddendum({ now: new Date() }),
      provider,
    ),
    messages,
    tools,
    providerOptions: provider.replyProviderOptions(),
    ...(options.abortSignal !== undefined
      ? { abortSignal: options.abortSignal }
      : {}),
    stopWhen: [
      ({ steps }) => steps.length >= STAFF_ASSISTANT_MAX_STEPS,
      ({ steps }) => hostShouldStopAfterHitl(steps),
    ],
    prepareStep: ({ steps }) => {
      if (steps.some(stepHasHitl)) {
        return { activeTools: [] };
      }
      return undefined;
    },
  });

  let rawText: string;
  try {
    rawText = await result.text;
  } catch {
    rawText = "";
  }

  let steps: Array<StepResult<ToolSet>>;
  try {
    steps = await result.steps;
  } catch {
    steps = [];
  }

  const fromSteps = lastUsableHostModelText(steps.map((step) => step.text));
  const speech = commitHostSpeech({
    locale,
    rawText: fromSteps ?? (steps.length === 0 ? rawText : ""),
    runs: [...(options.priorRuns ?? []), ...state.runs],
    toolOutputs: presentedToolResults.map((item) => item.output),
  });

  if (options.checkpoint !== undefined && state.messageId !== undefined) {
    await options.checkpoint.complete({
      messageId: state.messageId,
      body: speech.text,
    });
  }

  return {
    speech,
    text: speech.text,
    toolRuns: attachClippedModelTraces(
      state.runs.slice(0, STAFF_ASSISTANT_TOOL_RUNS_MAX),
      presentedToolResults,
    ),
    modelToolCalls: hostModelToolCallsFromSteps(steps),
    usage: await staffAssistantTurnUsageFromTotal(result.usage),
    toolsAttached: Object.keys(tools).length > 0,
    modelSteps: steps.length,
    toolResultBytesIn: clipBytes.in,
    toolResultBytesOut: clipBytes.out,
    toolsetHash,
    historyMessageCount: history.messageCount,
    historyChars: history.chars,
    historyTraceChars: history.traceChars,
  };
}

/**
 * Phase B resume: same `streamText` host turn from persisted history.
 * Callers must pass `getModelHistory` messages — do not append a second
 * copy of the original user text.
 */
export async function continueStaffAssistantHostTurn(
  options: StaffAssistantHostTurnOptions,
): Promise<StaffAssistantHostTurnResult> {
  return runStaffAssistantHostTurn(options);
}
