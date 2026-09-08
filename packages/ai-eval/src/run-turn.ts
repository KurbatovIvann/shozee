import {
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  estimateStaffAssistantTurnCostUsd,
  filterStaffAiTools,
  runStaffAssistantHostTurn,
  staffAssistantTurnContextAddendum,
  type ActionToolExecute,
  type LanguageModel,
  type StaffAssistantHostModelToolCall,
  type StaffAssistantTurnUsage,
} from "@showzy/ai";
import type { ActionContract } from "@showzy/core/contract";
import type { ModelMessage } from "ai";

import type { EvalTurnTrace } from "./expectation.js";
import { logEvalInfo, type EvalLogger } from "./log.js";
import { collectEvalToolCalls, type EvalToolCall } from "./trace.js";

const OWNER_MEMBERSHIP = { role: "owner" as const, permissions: [] };

export interface EvalTurnModels {
  readonly languageModel: LanguageModel;
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
}

function capturingExecute(
  execute: ActionToolExecute,
  executeResults: Map<string, unknown>,
): ActionToolExecute {
  return async (actionName, input, toolOptions) => {
    const result = await execute(actionName, input, toolOptions);
    executeResults.set(toolOptions.toolCallId, result);
    return result;
  };
}

/**
 * Same payload shape as host `modelToolCalls`: façade / provider
 * `input`, not canonical execute input.
 */
function evalPayloadsFromHostModelToolCalls(
  calls: readonly StaffAssistantHostModelToolCall[],
): unknown[] {
  return calls.map((call) => ({
    type: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  }));
}

function finishEvalTurn(options: {
  readonly logger: EvalLogger;
  readonly text: string;
  readonly toolCalls: readonly EvalToolCall[];
  readonly speechSource: EvalTurnTrace["speechSource"];
  readonly usage: StaffAssistantTurnUsage;
  readonly replyModelId: string;
  readonly gateModelId: string;
}): EvalTurnResult {
  const estimatedCostUsd =
    estimateStaffAssistantTurnCostUsd({
      reply: options.usage,
      replyModelId: options.replyModelId,
      gate: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
      gateModelId: options.gateModelId,
    }) ?? 0;

  logEvalInfo(
    options.logger,
    {
      tool_names: options.toolCalls.map((call) => call.name),
      input_tokens: options.usage.inputTokens,
      output_tokens: options.usage.outputTokens,
      cache_read_tokens: options.usage.cacheReadTokens,
      cache_write_tokens: options.usage.cacheWriteTokens,
      gate_input_tokens: 0,
      gate_output_tokens: 0,
      estimated_cost_usd: estimatedCostUsd,
      reply_model: options.replyModelId,
      gate_model: options.gateModelId,
    },
    "ai-eval turn usage",
  );

  return {
    trace: {
      text: options.text,
      toolCalls: options.toolCalls,
      ...(options.speechSource !== undefined
        ? { speechSource: options.speechSource }
        : {}),
    },
    usage: options.usage,
    gateUsage: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    estimatedCostUsd,
    replyModelId: options.replyModelId,
    gateModelId: options.gateModelId,
  };
}

/**
 * One staff-assistant turn on the live host (`runStaffAssistantHostTurn`,
 * ADR-0037 / SHO-524). `host` is accepted for corpus compatibility and
 * ignored — both `"live"` and `"new"` use this loop.
 */
export async function runStaffAssistantEvalTurn(options: {
  readonly models: EvalTurnModels;
  readonly messages: readonly ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly logger: EvalLogger;
  readonly companyName?: string;
  readonly host?: "live" | "new";
}): Promise<EvalTurnResult> {
  const catalog = filterStaffAiTools(options.contracts, OWNER_MEMBERSHIP);
  const executeResults = new Map<string, unknown>();
  const turn = await runStaffAssistantHostTurn({
    model: options.models.languageModel,
    messages: [...options.messages],
    contracts: catalog,
    execute: capturingExecute(options.execute, executeResults),
    turnContextAddendum: staffAssistantTurnContextAddendum({
      now: new Date(),
      ...(options.companyName !== undefined
        ? { companyName: options.companyName }
        : {}),
    }),
  });
  return finishEvalTurn({
    logger: options.logger,
    text: turn.text,
    toolCalls: collectEvalToolCalls(
      evalPayloadsFromHostModelToolCalls(turn.modelToolCalls),
      executeResults,
    ),
    speechSource: turn.speech.source,
    usage: turn.usage,
    replyModelId: options.models.replyModelId,
    gateModelId: options.models.gateModelId,
  });
}
