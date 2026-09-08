import {
  classifyStaffAssistantTurn,
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  estimateStaffAssistantTurnCostUsd,
  filterStaffAiTools,
  runStaffAssistantHostTurn,
  staffAssistantGateToolPolicy,
  staffAssistantTurnContextAddendum,
  streamStaffAssistantChat,
  type ActionToolExecute,
  type LanguageModel,
  type StaffAssistantToolRun,
  type StaffAssistantTurnUsage,
} from "@showzy/ai";
import type { ActionContract } from "@showzy/core/contract";
import type { ModelMessage } from "ai";

import type { EvalTurnTrace } from "./expectation.js";
import { logEvalInfo, type EvalLogger } from "./log.js";
import type { EvalAssistantHost } from "./scenario.js";
import {
  collectEvalToolCallsFromResponse,
  type EvalToolCall,
} from "./trace.js";

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

function capturingExecute(
  execute: ActionToolExecute,
  executeResults: Map<string, unknown>,
  executeInputs?: Map<string, unknown>,
): ActionToolExecute {
  return async (actionName, input, toolOptions) => {
    const result = await execute(actionName, input, toolOptions);
    executeResults.set(toolOptions.toolCallId, result);
    executeInputs?.set(toolOptions.toolCallId, input);
    return result;
  };
}

function evalToolCallsFromHostRuns(
  runs: readonly StaffAssistantToolRun[],
  executeResults: ReadonlyMap<string, unknown>,
  executeInputs: ReadonlyMap<string, unknown>,
): EvalToolCall[] {
  return runs.map((run) => {
    const result = executeResults.get(run.toolCallId);
    const args = executeInputs.get(run.toolCallId);
    return {
      toolCallId: run.toolCallId,
      name: run.toolName ?? run.actionName,
      args,
      ...(result !== undefined ? { result } : {}),
    };
  });
}

function finishEvalTurn(options: {
  readonly logger: EvalLogger;
  readonly text: string;
  readonly toolCalls: readonly EvalToolCall[];
  readonly speechSource: EvalTurnTrace["speechSource"];
  readonly usage: StaffAssistantTurnUsage;
  readonly gateUsage: StaffAssistantTurnUsage;
  readonly replyModelId: string;
  readonly gateModelId: string;
}): EvalTurnResult {
  const estimatedCostUsd =
    estimateStaffAssistantTurnCostUsd({
      reply: options.usage,
      replyModelId: options.replyModelId,
      gate: options.gateUsage,
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
      gate_input_tokens: options.gateUsage.inputTokens,
      gate_output_tokens: options.gateUsage.outputTokens,
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
    gateUsage: options.gateUsage,
    estimatedCostUsd,
    replyModelId: options.replyModelId,
    gateModelId: options.gateModelId,
  };
}

async function runNewHostEvalTurn(options: {
  readonly models: EvalTurnModels;
  readonly messages: readonly ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly logger: EvalLogger;
  readonly companyName?: string;
}): Promise<EvalTurnResult> {
  const executeResults = new Map<string, unknown>();
  const executeInputs = new Map<string, unknown>();
  const turn = await runStaffAssistantHostTurn({
    model: options.models.languageModel,
    messages: [...options.messages],
    contracts: options.contracts,
    execute: capturingExecute(options.execute, executeResults, executeInputs),
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
    toolCalls: evalToolCallsFromHostRuns(
      turn.toolRuns,
      executeResults,
      executeInputs,
    ),
    speechSource: turn.speech.source,
    usage: turn.usage,
    gateUsage: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    replyModelId: options.models.replyModelId,
    gateModelId: options.models.gateModelId,
  });
}

/**
 * One staff-assistant turn. `host: "new"` drives `runStaffAssistantHostTurn`
 * (MODEL_SPEAKS / ADR-0037). Default `live` keeps `streamStaffAssistantChat`
 * and the HTTP gate. Do not retarget production `POST /assistant/chat`.
 */
export async function runStaffAssistantEvalTurn(options: {
  readonly models: EvalTurnModels;
  readonly messages: readonly ModelMessage[];
  readonly contracts: readonly ActionContract[];
  readonly execute: ActionToolExecute;
  readonly logger: EvalLogger;
  readonly companyName?: string;
  readonly host?: EvalAssistantHost;
}): Promise<EvalTurnResult> {
  const catalog = filterStaffAiTools(options.contracts, OWNER_MEMBERSHIP);
  if (options.host === "new") {
    return runNewHostEvalTurn({
      models: options.models,
      messages: options.messages,
      contracts: catalog,
      execute: options.execute,
      logger: options.logger,
      ...(options.companyName !== undefined
        ? { companyName: options.companyName }
        : {}),
    });
  }

  let gateUsage = EMPTY_STAFF_ASSISTANT_TURN_USAGE;
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
  const execute = capturingExecute(options.execute, executeResults);

  const { response, completion } = streamStaffAssistantChat({
    model: replyModel,
    messages: [...options.messages],
    contracts: streamContracts,
    execute,
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
  return finishEvalTurn({
    logger: options.logger,
    text: turn.text,
    toolCalls,
    speechSource: turn.speech.source,
    usage: turn.usage,
    gateUsage,
    replyModelId,
    gateModelId: options.models.gateModelId,
  });
}
