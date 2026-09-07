import {
  classifyStaffAssistantTurn,
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  estimateStaffAssistantTurnCostUsd,
  filterStaffAiTools,
  staffAssistantGateToolPolicy,
  staffAssistantTurnContextAddendum,
  streamStaffAssistantChat,
  type ActionToolExecute,
  type LanguageModel,
  type StaffAssistantForcedToolName,
  type StaffAssistantTurnUsage,
} from "@showzy/ai";
import type { ActionContract } from "@showzy/core/contract";
import type { ModelMessage } from "ai";

import type { EvalTurnTrace } from "./expectation.js";
import { logEvalInfo, type EvalLogger } from "./log.js";
import { collectEvalToolCallsFromResponse } from "./trace.js";

const OWNER_MEMBERSHIP = { role: "owner" as const, permissions: [] };

export interface EvalTurnModels {
  readonly languageModel: LanguageModel;
  readonly gateLanguageModel?: LanguageModel;
  readonly replyModelId: string;
  readonly gateModelId: string;
}

export interface EvalTurnResult {
  readonly trace: EvalTurnTrace;
  readonly usage: StaffAssistantTurnUsage;
  readonly gateUsage: StaffAssistantTurnUsage;
  readonly estimatedCostUsd: number;
  readonly replyModelId: string;
  readonly gateModelId: string;
  readonly forcedToolName?: StaffAssistantForcedToolName;
}

function lastUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/**
 * One staff-assistant turn with the HTTP gate policy (chitchat / forced
 * job / full catalog) and injected models + `execute`.
 */
export async function runStaffAssistantEvalTurn(options: {
  readonly models: EvalTurnModels;
  readonly messages: readonly ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly logger: EvalLogger;
  readonly companyName?: string;
}): Promise<EvalTurnResult> {
  const catalog = filterStaffAiTools(options.contracts, OWNER_MEMBERSHIP);
  let gateUsage = EMPTY_STAFF_ASSISTANT_TURN_USAGE;
  let forcedToolName: StaffAssistantForcedToolName | undefined;
  let attachTools = true;

  const lastText = lastUserText(options.messages);
  if (
    options.models.gateLanguageModel !== undefined &&
    lastText.trim() !== ""
  ) {
    const classified = await classifyStaffAssistantTurn({
      model: options.models.gateLanguageModel,
      lastUserText: lastText,
    });
    gateUsage = classified.usage;
    const policy = staffAssistantGateToolPolicy(classified);
    if (policy.kind === "none") {
      attachTools = false;
    } else if (policy.kind === "forced") {
      forcedToolName = policy.toolName;
    }
  }

  const streamContracts = attachTools ? catalog : [];
  const replyModel =
    !attachTools && options.models.gateLanguageModel !== undefined
      ? options.models.gateLanguageModel
      : options.models.languageModel;
  const replyModelId = attachTools
    ? options.models.replyModelId
    : options.models.gateModelId;

  const executeResults = new Map<string, unknown>();
  const execute: ActionToolExecute = async (actionName, input, toolOptions) => {
    const result = await options.execute(actionName, input, toolOptions);
    executeResults.set(toolOptions.toolCallId, result);
    return result;
  };

  const { response, completion } = streamStaffAssistantChat({
    model: replyModel,
    messages: [...options.messages],
    contracts: streamContracts,
    execute,
    ...(forcedToolName !== undefined ? { forcedToolName } : {}),
    turnContextAddendum: staffAssistantTurnContextAddendum({
      now: new Date(),
      ...(options.companyName !== undefined
        ? { companyName: options.companyName }
        : {}),
    }),
  });

  const { toolCalls } = await collectEvalToolCallsFromResponse(
    response,
    executeResults,
  );
  const turn = await completion;
  const estimatedCostUsd = estimateStaffAssistantTurnCostUsd({
    reply: turn.usage,
    replyModelId,
    gate: gateUsage,
    gateModelId: options.models.gateModelId,
  });

  logEvalInfo(
    options.logger,
    {
      tool_names: toolCalls.map((call) => call.name),
      input_tokens: turn.usage.inputTokens,
      output_tokens: turn.usage.outputTokens,
      cache_read_tokens: turn.usage.cacheReadTokens,
      cache_write_tokens: turn.usage.cacheWriteTokens,
      gate_input_tokens: gateUsage.inputTokens,
      gate_output_tokens: gateUsage.outputTokens,
      estimated_cost_usd: estimatedCostUsd,
      reply_model: replyModelId,
      gate_model: options.models.gateModelId,
    },
    "ai-eval turn usage",
  );

  return {
    trace: { text: turn.text, toolCalls },
    usage: turn.usage,
    gateUsage,
    estimatedCostUsd,
    replyModelId,
    gateModelId: options.models.gateModelId,
    ...(forcedToolName !== undefined ? { forcedToolName } : {}),
  };
}
