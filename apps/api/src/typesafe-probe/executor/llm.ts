import type { LanguageModel } from "@showzy/ai";
import { generateText, tool } from "ai";
import { z } from "zod";

import { normalizeSpan } from "./candidates.js";
import {
  CLOSED_SLOTS,
  EXECUTOR_JOBS,
  EXECUTOR_NONE,
  ITEM_POSITIONS,
  type ExecutorJob,
} from "./corpus.js";
import type { PlanPick, PlanRow } from "./plan.js";

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const JOB_NAMES = Object.keys(EXECUTOR_JOBS) as [ExecutorJob, ...ExecutorJob[]];
const text = z.string().nullable();

const planSchema = z.object({
  jobs: z.array(z.enum(JOB_NAMES)),
  customerName: text,
  customerPhone: text,
  groupName: text,
  productName: text,
  priceListName: text,
  orderNumber: text,
  price: text,
  documentType: z.enum(["payment_invoice", "delivery_note"]).nullable(),
  period: z
    .enum(["today", "this_week", "this_month", "other_period"])
    .nullable(),
  statusFilter: z
    .enum(["new", "confirmed", "in_progress", "done", "canceled"])
    .nullable(),
  inviteKind: z.enum(["personal", "reusable"]).nullable(),
  items: z.array(z.object({ product: z.string(), quantity: text })),
});

export const PLAN_SYSTEM_PROMPT = [
  "You turn one message from a staff member of a small Ukrainian business into a plan for the business assistant. Call submit_plan exactly once.",
  "jobs: every job the message asks for, from this list only. Leave it empty for small talk, a question about what the assistant can do, or a request the list does not cover.",
  ...Object.entries(EXECUTOR_JOBS).map(
    ([job, { yes, no }]) => `- ${job}: ${yes}. Not this job: ${no}`,
  ),
  "Arguments: copy names of customers, groups, products and price lists exactly as written in the message, without surrounding words. Write every number, phone, order number, price and quantity as digits. Use null for anything the message does not state; never invent a value.",
  "items: one entry per product of a new order, product name without its quantity; quantity null when it is not stated.",
].join("\n");

export const NORMALIZE_SYSTEM_PROMPT = [
  "Rewrite a staff member's message as plain, explicit Ukrainian for a downstream classifier that reads it literally.",
  "Keep every fact and invent nothing. One short sentence per requested action, in the order asked.",
  "Write every number, phone number, order number, price and quantity as digits, and put a quantity directly before its product.",
  "Keep names of people, groups, products and price lists exactly as the user wrote them.",
  "Apply the user's own corrections and drop fillers. If the message is small talk or only asks whether something is possible, return it unchanged.",
  "Output only the rewritten message.",
].join("\n");

function usageOf(usage: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
}): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

export async function normalizeWithLlm(
  model: LanguageModel,
  message: string,
): Promise<{ readonly text: string; readonly usage: LlmUsage }> {
  const result = await generateText({
    model,
    system: NORMALIZE_SYSTEM_PROMPT,
    prompt: message,
    maxOutputTokens: 400,
  });
  return { text: result.text.trim(), usage: usageOf(result.usage) };
}

const stated = (value: string | null): PlanPick => ({
  choice:
    value === null || normalizeSpan(value) === ""
      ? EXECUTOR_NONE
      : normalizeSpan(value),
  confidence: 1,
});

export async function planWithLlm(
  model: LanguageModel,
  caseId: string,
  message: string,
  now: () => number = () => performance.now(),
): Promise<{ readonly row: PlanRow; readonly usage: LlmUsage }> {
  const startedAt = now();
  const result = await generateText({
    model,
    system: PLAN_SYSTEM_PROMPT,
    prompt: message,
    maxOutputTokens: 800,
    tools: {
      submit_plan: tool({
        description: "Submit the plan for the staff member's message.",
        inputSchema: planSchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "submit_plan" },
  });
  const usage = usageOf(result.usage);
  const base = {
    caseId,
    latencyMs: now() - startedAt,
    inputTokens: usage.inputTokens,
  };
  const parsed = planSchema.safeParse(result.toolCalls[0]?.input);
  if (!parsed.success) {
    return {
      row: { ...base, refusal: "unavailable", jobs: {}, picks: {} },
      usage,
    };
  }
  const plan = parsed.data;
  const picks: Record<string, PlanPick> = {
    slot_customerName: stated(plan.customerName),
    slot_customerPhone: stated(plan.customerPhone),
    slot_groupName: stated(plan.groupName),
    slot_productName: stated(plan.productName),
    slot_priceListName: stated(plan.priceListName),
    slot_orderNumber: stated(plan.orderNumber),
    slot_price: stated(plan.price),
  };
  for (const slot of Object.keys(CLOSED_SLOTS)) {
    const value = plan[slot as keyof typeof CLOSED_SLOTS];
    picks[`slot_${slot}`] = { choice: value ?? EXECUTOR_NONE, confidence: 1 };
  }
  for (const position of ITEM_POSITIONS) {
    const entry = plan.items[position - 1];
    if (entry !== undefined) {
      picks[`item${String(position)}_product`] = stated(entry.product);
      picks[`item${String(position)}_quantity`] = stated(entry.quantity);
    }
  }
  return {
    row: {
      ...base,
      jobs: Object.fromEntries(plan.jobs.map((job) => [`job_${job}`, 1])),
      picks,
    },
    usage,
  };
}
