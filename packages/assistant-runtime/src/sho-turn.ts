import { kyivCalendarDate } from "@showzy/ai";
import {
  providerToolCallId,
  type ChatPart,
  type Continuation,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import type { ShoFallbackReason, ShoResult } from "@showzy/sho-protocol";

import type { ShoPlanFallbackReason } from "./sho-plan.js";

import {
  emptyStaffAssistantBudgetHold,
  type StaffAssistantBudgetHold,
} from "./assistant-budget-guard.js";
import {
  assistantAskedMessage,
  assistantTurnEarnedCard,
} from "./stores/assistant-turn-store.js";

export const SHO_TOOL_CALL_PREFIX = "sho-";

export type ShoTurnFallbackReason =
  | "engine_failed"
  | "tools_unreadable"
  | "tool_unavailable"
  | "tool_failed"
  | "unsendable_tool_call_id"
  | ShoFallbackReason
  | ShoPlanFallbackReason;

export interface ShoToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reply: string;
}

export type ShoPlan =
  | ({ readonly kind: "call" } & ShoToolCall)
  | { readonly kind: "fallback"; readonly reason: ShoTurnFallbackReason };

export interface ShoTurnRequest {
  readonly text: string;
  readonly now: Date;
}

export interface ShoPlanned {
  readonly plan: ShoPlan;
  readonly result: ShoResult | null;
}

export interface ShoEngine {
  readonly plan: (request: ShoTurnRequest) => Promise<ShoPlanned>;
}

export interface ShoTurnSettled {
  readonly kind: "settled";
  readonly parts: readonly ChatPart[];
  readonly appended: readonly ModelMessage[];
  readonly result: ShoResult | null;
}

export interface ShoTurnAsk {
  readonly kind: "ask";
  readonly interaction: string;
  readonly prompt: unknown;
  readonly secret: unknown;
  readonly continuation: Continuation;
  readonly appended: readonly ModelMessage[];
  readonly result: ShoResult | null;
}

export interface ShoTurnFallback {
  readonly kind: "fallback";
  readonly reason: ShoTurnFallbackReason;
  readonly result: ShoResult | null;
}

export type ShoTurnOutcome = ShoTurnSettled | ShoTurnAsk | ShoTurnFallback;

export interface ShoTurnInput {
  readonly text: string;
  readonly commandId: string;
  readonly now: Date;
  readonly history: readonly ModelMessage[];
  readonly tools: () => Promise<ToolSet>;
  readonly engine: ShoEngine;
}

export function shoFreeBudgetHold(now: Date): StaffAssistantBudgetHold {
  return emptyStaffAssistantBudgetHold(kyivCalendarDate(now));
}

const sendable = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

export function shoToolCallId(
  commandId: string,
  seq: number,
  toolName: string,
): string {
  return `${SHO_TOOL_CALL_PREFIX}${String(seq)}-${sendable(toolName)}-${sendable(commandId)}`;
}

function failed(
  reason: ShoTurnFallbackReason,
  result: ShoResult | null,
): ShoTurnFallback {
  return { kind: "fallback", reason, result };
}

function conversationThrough(
  input: ShoTurnInput,
  toolCallId: string,
  call: ShoToolCall,
  output: unknown,
): ModelMessage[] {
  return [
    ...input.history,
    assistantAskedMessage(input.text),
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: call.toolName,
          input: call.input,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: call.toolName,
          output: { type: "json", value: output as never },
        },
      ],
    },
  ];
}

export async function runShoTurn(input: ShoTurnInput): Promise<ShoTurnOutcome> {
  let planned: ShoPlanned;
  try {
    planned = await input.engine.plan({ text: input.text, now: input.now });
  } catch {
    return failed("engine_failed", null);
  }
  const { plan, result } = planned;
  if (plan.kind === "fallback") {
    return failed(plan.reason, result);
  }

  const toolCallId = shoToolCallId(input.commandId, 1, plan.toolName);
  const sendableId = providerToolCallId(toolCallId);
  if (sendableId.kind !== "ok") {
    return failed("unsendable_tool_call_id", result);
  }

  let execute: ToolSet[string]["execute"];
  try {
    execute = (await input.tools())[plan.toolName]?.execute;
  } catch {
    return failed("tools_unreadable", result);
  }
  if (execute === undefined) {
    return failed("tool_unavailable", result);
  }

  let outcome: ToolOutcome;
  try {
    outcome = (await execute(plan.input, {
      toolCallId,
      messages: [],
    } as never)) as ToolOutcome;
  } catch {
    return failed("tool_failed", result);
  }

  if (outcome.kind === "error") {
    return failed("tool_failed", result);
  }

  if (outcome.kind === "pause") {
    const messages = conversationThrough(input, toolCallId, plan, {
      status: "paused",
      reason: outcome.interaction,
    });
    return {
      kind: "ask",
      interaction: outcome.interaction,
      prompt: outcome.prompt,
      secret: outcome.secret,
      continuation: {
        messages,
        pausedToolCall: { id: sendableId.id, name: plan.toolName },
      },
      appended: messages.slice(input.history.length),
      result,
    };
  }

  const whole = conversationThrough(input, toolCallId, plan, outcome.result);
  return {
    kind: "settled",
    parts: [
      ...assistantTurnEarnedCard(outcome.card),
      { kind: "text", text: plan.reply, status: "complete" },
    ],
    appended: [
      ...whole.slice(input.history.length),
      { role: "assistant", content: plan.reply },
    ],
    result,
  };
}
