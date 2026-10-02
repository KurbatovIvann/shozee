import { kyivCalendarDate } from "@showzy/ai";
import {
  providerToolCallId,
  type ChatPart,
  type Continuation,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import type { ShoFallbackReason } from "@showzy/sho-protocol";

import {
  emptyStaffAssistantBudgetHold,
  type StaffAssistantBudgetHold,
} from "./assistant-budget-guard.js";
import { assistantTurnEarnedCard } from "./stores/assistant-turn-store.js";

export const SHO_TOOL_CALL_PREFIX = "sho-";

export const SHO_TURN_FALLBACK_REASONS = [
  "engine_failed",
  "not_planned",
  "tool_unavailable",
  "tool_failed",
  "unsendable_tool_call_id",
] as const;

export type ShoTurnFallbackReason =
  (typeof SHO_TURN_FALLBACK_REASONS)[number] | ShoFallbackReason;

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

export interface ShoEngine {
  readonly plan: (request: ShoTurnRequest) => Promise<ShoPlan>;
}

export interface ShoTurnSettled {
  readonly kind: "settled";
  readonly parts: readonly ChatPart[];
  readonly history: readonly ModelMessage[];
}

export interface ShoTurnAsk {
  readonly kind: "ask";
  readonly interaction: string;
  readonly prompt: unknown;
  readonly secret: unknown;
  readonly continuation: Continuation;
  readonly history: readonly ModelMessage[];
}

export interface ShoTurnFallback {
  readonly kind: "fallback";
  readonly reason: ShoTurnFallbackReason;
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

export function isShoToolCall(toolCallId: string): boolean {
  return toolCallId.startsWith(SHO_TOOL_CALL_PREFIX);
}

function failed(reason: ShoTurnFallbackReason): ShoTurnFallback {
  return { kind: "fallback", reason };
}

function syntheticMessages(
  input: ShoTurnInput,
  toolCallId: string,
  call: ShoToolCall,
  output: unknown,
): ModelMessage[] {
  return [
    ...input.history,
    { role: "user", content: input.text },
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
  let plan: ShoPlan;
  try {
    plan = await input.engine.plan({ text: input.text, now: input.now });
  } catch {
    return failed("engine_failed");
  }
  if (plan.kind === "fallback") {
    return failed(plan.reason);
  }

  const toolCallId = shoToolCallId(input.commandId, 1, plan.toolName);
  const sendableId = providerToolCallId(toolCallId);
  if (sendableId.kind !== "ok") {
    return failed("unsendable_tool_call_id");
  }

  const execute = (await input.tools())[plan.toolName]?.execute;
  if (execute === undefined) {
    return failed("tool_unavailable");
  }

  let outcome: ToolOutcome;
  try {
    outcome = (await execute(plan.input, {
      toolCallId,
      messages: [],
    } as never)) as ToolOutcome;
  } catch {
    return failed("tool_failed");
  }

  if (outcome.kind === "error") {
    return failed("tool_failed");
  }

  if (outcome.kind === "pause") {
    const messages = syntheticMessages(input, toolCallId, plan, {
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
      history: messages,
    };
  }

  return {
    kind: "settled",
    parts: [
      ...assistantTurnEarnedCard(outcome.card),
      { kind: "text", text: plan.reply, status: "complete" },
    ],
    history: [
      ...syntheticMessages(input, toolCallId, plan, outcome.result),
      { role: "assistant", content: plan.reply },
    ],
  };
}
