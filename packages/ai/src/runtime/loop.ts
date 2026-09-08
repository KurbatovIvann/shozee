/**
 * New staff-assistant host loop (ADR-0037 / SHO-520).
 *
 * One `streamText` call. Tests invoke this directly. Do not retarget
 * production `POST /assistant/chat`. Do not call the intent gate or
 * the live speaker.
 */
import type { ActionContract } from "@showzy/core/contract";
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
  isStaffAssistantNeedsChoiceOutput,
  toolOutputRequestsChoice,
  type ChoiceBind,
  type ChoiceRecord,
} from "../choice.js";
import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "../clip-tool-result.js";
import { isStaffAssistantConfirmationOutput } from "../confirmation.js";
import {
  staffAssistantJsonChars,
  staffAssistantPostgresJsonbTextChars,
} from "../json-chars.js";
import {
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  type StaffAssistantLocale,
} from "../locale.js";
import {
  staffAssistantHistoryStats,
  stripStaffAssistantToolParts,
} from "../messages.js";
import { anthropicStaffProvider } from "../provider/anthropic.js";
import type { StaffProviderAdapter } from "../provider/types.js";
import {
  STAFF_ASSISTANT_MAX_STEPS,
  STAFF_ASSISTANT_TOOL_CALL_ID_MAX,
  STAFF_ASSISTANT_TOOL_RUNS_MAX,
  type StaffAssistantToolRun,
  type StaffAssistantTurnResult,
} from "../staff-assistant-stream.js";
import { staffAssistantSystemMessages } from "../system-prompt.js";
import { staffAssistantToolsetHash } from "../toolset-hash.js";
import { staffAssistantTurnContextAddendum } from "../turn-context.js";
import {
  isStaffAssistantTypedToolError,
  type StaffAssistantPresentedToolResult,
} from "../turn-speech.js";
import { staffAssistantTurnUsageFromTotal } from "../usage.js";

import {
  isHostHitlPausedOutput,
  wrapHostSequentialExecute,
  type StaffAssistantHostPendingDecision,
} from "./execute.js";
import {
  commitHostSpeech,
  lastUsableHostModelText,
  usableHostModelText,
} from "./speech.js";

export type { StaffAssistantHostPendingDecision } from "./execute.js";
export {
  allowHostPendingAlways,
  HOST_HITL_PAUSED_OUTPUT,
  HOST_HITL_PAUSED_STATUS,
  isHostHitlPausedOutput,
} from "./execute.js";
export {
  commitHostSpeech,
  lastUsableHostModelText,
  usableHostModelText,
} from "./speech.js";

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
        if (isHostHitlPausedOutput(output)) {
          return output;
        }
        const returned = meterToolResult(
          clipBytes,
          output,
          clipStaffAssistantToolResult(output),
        );
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
  readonly mintChoiceId?: () => string;
  readonly provider?: StaffProviderAdapter;
  readonly checkPending?: () => Promise<StaffAssistantHostPendingDecision>;
}

/**
 * One `streamText` host turn. Not mounted on live `/assistant/chat`.
 */
export async function runStaffAssistantHostTurn(
  options: StaffAssistantHostTurnOptions,
): Promise<StaffAssistantTurnResult> {
  const state = { paused: false, runs: [] as StaffAssistantToolRun[] };
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
      ...(options.mintChoiceId !== undefined
        ? { mintChoiceId: options.mintChoiceId }
        : {}),
      ...(options.checkPending !== undefined
        ? { checkPending: options.checkPending }
        : {}),
    }),
    provider,
  );
  clipToolExecutes(tools, clipBytes, presentedToolResults);
  const toolsetHash = staffAssistantToolsetHash(
    Object.keys(tools),
    provider.id,
  );
  const messages =
    Object.keys(tools).length === 0
      ? stripStaffAssistantToolParts(options.messages, provider)
      : options.messages;
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
    runs: state.runs,
    toolOutputs: presentedToolResults.map((item) => item.output),
  });

  return {
    speech,
    text: speech.text,
    toolRuns: attachClippedModelTraces(
      state.runs.slice(0, STAFF_ASSISTANT_TOOL_RUNS_MAX),
      presentedToolResults,
    ),
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
