import { randomUUID } from "node:crypto";

import {
  kyivCalendarDate,
  mapOrdersCreateInput,
  ordersCreateInputSchema,
} from "@showzy/ai";
import {
  providerToolCallId,
  type ChatPart,
  type Continuation,
  type ModelMessage,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";

import type { StaffAssistantBudgetHold } from "./assistant-budget-guard.js";
import type {
  ChoiceSecret,
  ConfirmationSecret,
} from "./assistant-interactions.js";
import { assistantKitIdempotencyKey } from "./assistant-runtime.js";
import {
  planShoTurn,
  type ShoEngine,
  type ShoFallbackReason,
  type ShoPlan,
} from "./sho-plan.js";

export const SHO_TOOL_CALL_PREFIX = "sho-";
export const SHO_ORDERS_CREATE_ACTION = "orders.create";

export function shoFreeBudgetHold(now: Date): StaffAssistantBudgetHold {
  return {
    companyReservedUsd: 0,
    globalReservedUsd: 0,
    kyivDate: kyivCalendarDate(now),
  };
}

export function shoToolCallId(commandId: string): string {
  return `${SHO_TOOL_CALL_PREFIX}${commandId.replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function isShoToolCall(id: string): boolean {
  return id.startsWith(SHO_TOOL_CALL_PREFIX);
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
  readonly reason: ShoFallbackReason;
}

export type ShoTurnOutcome = ShoTurnSettled | ShoTurnAsk | ShoTurnFallback;

export interface ShoTurnInput {
  readonly text: string;
  readonly conversationId: string;
  readonly commandId: string;
  readonly now: Date;
  readonly history: readonly ModelMessage[];
  readonly tools: () => Promise<ToolSet>;
  readonly engine: ShoEngine;
}

interface ShoQuestion {
  readonly interaction: string;
  readonly prompt: unknown;
  readonly secret: unknown;
}

function failed(reason: ShoFallbackReason): ShoTurnFallback {
  return { kind: "fallback", reason };
}

function syntheticMessages(
  input: ShoTurnInput,
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  output: unknown,
): ModelMessage[] {
  return [
    ...input.history,
    { role: "user", content: input.text },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName, input: toolInput }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: output as never },
        },
      ],
    },
  ];
}

function askThrough(
  input: ShoTurnInput,
  call: { readonly toolName: string; readonly input: Record<string, unknown> },
  question: ShoQuestion,
): ShoTurnAsk | ShoTurnFallback {
  const raw = shoToolCallId(input.commandId);
  const id = providerToolCallId(raw);
  if (id.kind !== "ok") {
    return failed("engine_failed");
  }
  const messages = syntheticMessages(input, raw, call.toolName, call.input, {
    status: "paused",
    reason: question.interaction,
  });
  return {
    kind: "ask",
    ...question,
    continuation: {
      messages,
      pausedToolCall: { id: id.id, name: call.toolName },
    },
    history: messages,
  };
}

function fieldOf(result: unknown, name: string): unknown {
  return typeof result === "object" && result !== null && name in result
    ? (result as Record<string, unknown>)[name]
    : undefined;
}

export function shoReadReply(result: unknown): string {
  const rows = fieldOf(result, "rows");
  const count = Array.isArray(rows) ? rows.length : 0;
  return count === 0
    ? "Замовлень за цей період немає."
    : `Знайшов ${String(count)} замовлень.`;
}

export function shoWriteReply(result: unknown): string {
  const number = fieldOf(result, "orderNumber");
  return typeof number === "string" || typeof number === "number"
    ? `Створив замовлення №${String(number)}.`
    : "Замовлення створено.";
}

function settledParts(
  card: Extract<ToolOutcome, { kind: "ok" }>["card"],
  reply: string,
): ChatPart[] {
  const shown: ChatPart[] =
    card === undefined ? [] : [{ kind: "card", revision: 1, ...card }];
  return [...shown, { kind: "text", text: reply, status: "complete" }];
}

function confirmationQuestion(
  input: ShoTurnInput,
  plan: Extract<ShoPlan, { kind: "write" }>,
): ShoQuestion | null {
  let canonicalInput: unknown;
  try {
    canonicalInput = mapOrdersCreateInput(
      ordersCreateInputSchema.parse(plan.input),
    );
  } catch {
    return null;
  }
  const said = plan.input["items"];
  const lines = Array.isArray(said) ? said.length : 0;
  const secret: ConfirmationSecret = {
    actionName: SHO_ORDERS_CREATE_ACTION,
    canonicalInput,
    idempotencyKey: assistantKitIdempotencyKey(
      { conversationId: input.conversationId, commandId: input.commandId },
      SHO_ORDERS_CREATE_ACTION,
    ),
    challengeId: randomUUID(),
  };
  return {
    interaction: "confirmation",
    prompt: { summary: `Створити замовлення на ${String(lines)} позицій?` },
    secret,
  };
}

function choiceQuestion(
  plan: Extract<ShoPlan, { kind: "choice" }>,
): ShoQuestion {
  const secret: ChoiceSecret = {
    byOption: Object.fromEntries(
      plan.options.map((option) => [option.optionId, option.optionId]),
    ),
    toolName: plan.toolName,
    input: plan.input,
    target: plan.target,
  };
  return {
    interaction: "choice",
    prompt: {
      subject: plan.subject,
      options: plan.options,
      optionsTruncated: plan.optionsTruncated,
    },
    secret,
  };
}

export async function runShoTurn(input: ShoTurnInput): Promise<ShoTurnOutcome> {
  let plan: ShoPlan;
  try {
    plan = planShoTurn(
      await input.engine.parse({ raw: input.text, now: input.now }),
      input.now,
    );
  } catch {
    return failed("engine_failed");
  }
  if (plan.kind === "fallback") {
    return plan;
  }
  if (plan.kind === "choice") {
    return askThrough(input, plan, choiceQuestion(plan));
  }
  if (plan.kind === "write") {
    const question = confirmationQuestion(input, plan);
    return question === null
      ? failed("unsupported_param")
      : askThrough(input, plan, question);
  }

  const toolCallId = shoToolCallId(input.commandId);
  const execute = (await input.tools())[plan.toolName]?.execute;
  if (execute === undefined) {
    return failed("engine_failed");
  }
  const outcome = (await execute(plan.input, {
    toolCallId,
    messages: [],
  } as never)) as ToolOutcome;

  if (outcome.kind === "error") {
    return failed("engine_failed");
  }
  if (outcome.kind === "pause") {
    return askThrough(input, plan, {
      interaction: outcome.interaction,
      prompt: outcome.prompt,
      secret: outcome.secret,
    });
  }

  const reply = shoReadReply(outcome.result);
  return {
    kind: "settled",
    parts: settledParts(outcome.card, reply),
    history: [
      ...syntheticMessages(
        input,
        toolCallId,
        plan.toolName,
        plan.input,
        outcome.result,
      ),
      { role: "assistant", content: reply },
    ],
  };
}
