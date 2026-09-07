/**
 * Cheap mode classifier for the staff loop (SHO-340 / SHO-513).
 * Chitchat skips the tool catalog. Capability and job keep today's
 * hot set + Anthropic BM25. Fail-open: errors, empty last-user-text, and
 * `confidence: "low"` attach the full catalog. Never logs the user
 * message. Do not add a second agent. Do not force a tool.
 */
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

import { STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS } from "./anthropic-options.js";
import { STAFF_ASSISTANT_PRODUCT_GLOSSARY } from "./product-glossary.js";
import {
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  staffAssistantTurnUsageFromUnknown,
  type StaffAssistantTurnUsage,
} from "./usage.js";

export const STAFF_ASSISTANT_GATE_MODES = [
  "chitchat",
  "capability",
  "job",
] as const;
export type StaffAssistantGateMode =
  (typeof STAFF_ASSISTANT_GATE_MODES)[number];

export const STAFF_ASSISTANT_GATE_CONFIDENCE = ["high", "low"] as const;
export type StaffAssistantGateConfidence =
  (typeof STAFF_ASSISTANT_GATE_CONFIDENCE)[number];

export interface StaffAssistantGateResult {
  readonly mode: StaffAssistantGateMode;
  readonly confidence: StaffAssistantGateConfidence;
  readonly usage: StaffAssistantTurnUsage;
}

export type StaffAssistantGateToolPolicy =
  { readonly kind: "none" } | { readonly kind: "all" };

const FAIL_OPEN_GATE: Omit<StaffAssistantGateResult, "usage"> = {
  mode: "job",
  confidence: "low",
};

export const staffAssistantGateOutputSchema = z.object({
  mode: z.enum(STAFF_ASSISTANT_GATE_MODES),
  confidence: z.enum(STAFF_ASSISTANT_GATE_CONFIDENCE),
});

export const STAFF_ASSISTANT_GATE_SYSTEM = `Classify the staff member's last message for the Shozee company assistant. Reply with JSON only: mode and confidence.

mode:
- chitchat: greetings, small talk, weather, general knowledge, or anything with no company-work intent.
- capability: they ask whether / how you can help with this company's work (any language), including “what can you do”.
- job: they want to view or change this company's data.

confidence: high only when a single mode is clear. low when unsure. If you are unsure, mode job, confidence low.

Company-work domains (Ukrainian or English):
${STAFF_ASSISTANT_PRODUCT_GLOSSARY}

Examples:
Привіт → {"mode":"chitchat","confidence":"high"}
hello → {"mode":"chitchat","confidence":"high"}
Яка погода в Києві? → {"mode":"chitchat","confidence":"high"}
show last 3 orders → {"mode":"job","confidence":"high"}
Покажи активні замовлення → {"mode":"job","confidence":"high"}
how many orders today → {"mode":"job","confidence":"high"}
create an order for Леха → {"mode":"job","confidence":"high"}
can you help with price lists? → {"mode":"capability","confidence":"high"}
Чи можеш ти створювати прайс-листи? → {"mode":"capability","confidence":"high"}
А з чим ти можеш допомогти ще? → {"mode":"capability","confidence":"high"}
Створи новий прайс лист для лехи, ціни на 10% нижчі → {"mode":"job","confidence":"high"}
Show last orders and create a price list → {"mode":"job","confidence":"high"}
Скільки буде 2+2 → {"mode":"chitchat","confidence":"high"}`;

export function staffAssistantGateToolPolicy(
  result: Pick<StaffAssistantGateResult, "mode" | "confidence">,
): StaffAssistantGateToolPolicy {
  if (result.confidence !== "high") {
    return { kind: "all" };
  }
  if (result.mode === "chitchat") {
    return { kind: "none" };
  }
  return { kind: "all" };
}

export async function classifyStaffAssistantTurn(options: {
  readonly model: LanguageModel;
  readonly lastUserText: string;
  readonly abortSignal?: AbortSignal;
}): Promise<StaffAssistantGateResult> {
  const trimmed = options.lastUserText.trim();
  if (trimmed === "") {
    return { ...FAIL_OPEN_GATE, usage: EMPTY_STAFF_ASSISTANT_TURN_USAGE };
  }
  try {
    const result = await generateText({
      model: options.model,
      output: Output.object({ schema: staffAssistantGateOutputSchema }),
      system: STAFF_ASSISTANT_GATE_SYSTEM,
      prompt: trimmed,
      providerOptions: {
        anthropic: STAFF_ASSISTANT_ANTHROPIC_PROVIDER_OPTIONS,
      },
      ...(options.abortSignal !== undefined
        ? { abortSignal: options.abortSignal }
        : {}),
    });
    return {
      mode: result.output.mode,
      confidence: result.output.confidence,
      usage: staffAssistantTurnUsageFromUnknown(result.usage),
    };
  } catch {
    return { ...FAIL_OPEN_GATE, usage: EMPTY_STAFF_ASSISTANT_TURN_USAGE };
  }
}
