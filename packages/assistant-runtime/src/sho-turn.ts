import { kyivCalendarDate } from "@showzy/ai";
import {
  providerToolCallId,
  type ChatPart,
  type Continuation,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import type {
  ShoCommand,
  ShoFallbackReason,
  ShoFocusEntry,
  ShoPrevious,
} from "@showzy/sho-protocol";
import type { ShoPlanFallbackReason } from "./sho-plan.js";

import {
  shoFocusFrom,
  shoLogOptions,
  shoPreviousFrom,
  type ShoTurnLog,
} from "./sho-focus.js";

import {
  shoEscalationOf,
  shoGapsOf,
  shoStuckOnRepeatedGap,
  shoStuckOnRepeatedText,
  type ShoEscalation,
  type ShoGap,
  type ShoTrapKind,
} from "./sho-gaps.js";

import {
  emptyStaffAssistantBudgetHold,
  type StaffAssistantBudgetHold,
} from "./assistant-budget-guard.js";
import { promptNoting } from "./assistant-kit-confirmation.js";
import {
  assistantAskedMessage,
  assistantTurnEarnedCard,
} from "./stores/assistant-turn-store.js";

export const SHO_TOOL_CALL_PREFIX = "sho-";

export type ShoTurnFallbackReason =
  | "stuck"
  | "engine_failed"
  | "tools_unreadable"
  | "tool_unavailable"
  | "tool_failed"
  | "unsendable_tool_call_id"
  | "write_did_not_pause"
  | ShoFallbackReason
  | ShoPlanFallbackReason;

export interface ShoToolCall {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly reply: string;
  readonly writes: boolean;
  readonly notes?: readonly string[];
}

export type ShoPlan =
  | ({
      readonly kind: "call";
      readonly command?: ShoCommand;
    } & ShoToolCall)
  | {
      readonly kind: "fallback";
      readonly reason: ShoTurnFallbackReason;
      readonly command?: ShoCommand;
    };

export interface ShoTurnRequest {
  readonly text: string;
  readonly now: Date;
  readonly focus: readonly ShoFocusEntry[];
  readonly previous?: ShoPrevious;
}

export interface ShoEngine {
  readonly plan: (request: ShoTurnRequest) => Promise<ShoPlan>;
}

export interface ShoTurnSettled {
  readonly kind: "settled";
  readonly parts: readonly ChatPart[];
  readonly appended: readonly ModelMessage[];
}

export interface ShoTurnAsk {
  readonly kind: "ask";
  readonly interaction: string;
  readonly prompt: unknown;
  readonly secret: unknown;
  readonly continuation: Continuation;
  readonly appended: readonly ModelMessage[];
}

export interface ShoTurnFallback {
  readonly kind: "fallback";
  readonly reason: ShoTurnFallbackReason;
  readonly escalation: ShoEscalation;
}

export type ShoTurnOutcome = ShoTurnSettled | ShoTurnAsk | ShoTurnFallback;

export interface ShoTurnInput {
  readonly text: string;
  readonly commandId: string;
  readonly sessionId: string;
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

function fellBackOn(
  input: ShoTurnInput,
  reason: ShoTurnFallbackReason,
  gaps?: readonly ShoGap[],
  trap?: ShoTrapKind,
): ShoTurnFallback {
  return {
    kind: "fallback",
    reason,
    escalation: shoEscalationOf({
      reason,
      sessionId: input.sessionId,
      now: input.now,
      ...(gaps === undefined ? {} : { gaps }),
      ...(trap === undefined ? {} : { trap }),
    }),
  };
}

function conversationThrough(
  input: ShoTurnInput,
  toolCallId: string,
  call: ShoToolCall,
  output: unknown,
  log: ShoTurnLog | null,
): ModelMessage[] {
  return [
    ...input.history,
    assistantAskedMessage(input.text),
    {
      role: "assistant",
      ...(log === null ? {} : { providerOptions: shoLogOptions(log) }),
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
  const failed = (
    reason: ShoTurnFallbackReason,
    gaps?: readonly ShoGap[],
    trap?: ShoTrapKind,
  ): ShoTurnFallback => fellBackOn(input, reason, gaps, trap);

  const repeated = shoStuckOnRepeatedText({
    history: input.history,
    sessionId: input.sessionId,
    text: input.text,
  });
  if (repeated !== null) {
    return failed("stuck", repeated.gaps, repeated.trap);
  }

  const focus = shoFocusFrom(input.history, input.sessionId);
  const previous = shoPreviousFrom(input.history);
  let plan: ShoPlan;
  try {
    plan = await input.engine.plan({
      text: input.text,
      now: input.now,
      focus,
      ...(previous === undefined ? {} : { previous }),
    });
  } catch {
    return failed("engine_failed");
  }
  const parsed = plan.command;
  const gaps = parsed === undefined ? [] : shoGapsOf(parsed);
  if (plan.kind === "fallback") {
    return failed(plan.reason, gaps);
  }
  const asking = shoStuckOnRepeatedGap({
    history: input.history,
    sessionId: input.sessionId,
    gaps,
  });
  if (asking !== null) {
    return failed("stuck", asking.gaps, asking.trap);
  }
  const log: ShoTurnLog | null =
    parsed === undefined
      ? null
      : {
          command: parsed,
          sessionId: input.sessionId,
          at: input.now.toISOString(),
        };

  const toolCallId = shoToolCallId(input.commandId, 1, plan.toolName);
  const sendableId = providerToolCallId(toolCallId);
  if (sendableId.kind !== "ok") {
    return failed("unsendable_tool_call_id");
  }

  let execute: ToolSet[string]["execute"];
  try {
    execute = (await input.tools())[plan.toolName]?.execute;
  } catch {
    return failed("tools_unreadable");
  }
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

  if (plan.writes && outcome.kind !== "pause") {
    return failed("write_did_not_pause");
  }

  if (outcome.kind === "pause") {
    const notes = plan.notes ?? [];
    const messages = conversationThrough(
      input,
      toolCallId,
      plan,
      { status: "paused", reason: outcome.interaction },
      log,
    );
    return {
      kind: "ask",
      interaction: outcome.interaction,
      prompt: promptNoting(outcome.prompt, notes),
      secret: outcome.secret,
      continuation: {
        messages,
        pausedToolCall: { id: sendableId.id, name: plan.toolName },
        ...(notes.length === 0 ? {} : { promptNotes: notes }),
      },
      appended: messages.slice(input.history.length),
    };
  }

  const whole = conversationThrough(
    input,
    toolCallId,
    plan,
    outcome.result,
    log,
  );
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
  };
}
