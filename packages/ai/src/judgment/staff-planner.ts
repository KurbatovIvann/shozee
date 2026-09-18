import {
  JUDGMENT_MESSAGE_KINDS,
  type JudgmentDeclineReason,
  type JudgmentMessageKind,
  type JudgmentShadowArgValue,
} from "@showzy/validation/assistant-judgment";

import {
  JUDGMENT_CLOSED_SLOTS,
  JUDGMENT_NONE,
  JUDGMENT_NUMBER_SLOTS,
  JUDGMENT_SPAN_SLOTS,
  type JudgmentArgSpec,
  type StaffJudgmentSpec,
} from "../tool-facades/judgment-specs.js";
import { numberCandidates, spanCandidates } from "./candidates.js";
import type {
  JudgmentAnswer,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentRefusalReason,
  JudgmentText,
} from "./types.js";

export const JUDGMENT_TAKE_THRESHOLD = 0.7;
export const JUDGMENT_DOUBT_THRESHOLD = 0.3;
export const JUDGMENT_ARGUMENT_THRESHOLD = 0.7;
export const JUDGMENT_NEEDS_HISTORY_THRESHOLD = 0.5;
export const JUDGMENT_ITEM_POSITIONS = [1, 2, 3] as const;
export const JUDGMENT_ITEM_SENTINEL_POSITION = 4;

const ORDINALS = { 1: "first", 2: "second", 3: "third", 4: "fourth" } as const;
const NUMBER_IN_WORDS =
  /(тисяч|сот|дцять|десят|сорок|дев'яност|півтор|пів\s|чверт)/iu;

const KIND_CRITERIA: Readonly<Record<JudgmentMessageKind, string>> = {
  request:
    "Asks to look up, count, create, change, cancel or issue something in the business's own data.",
  capability_question:
    "Asks what the assistant can do or whether it supports something, without asking to do it now.",
  small_talk: "A greeting, thanks, acknowledgement or chat with no request.",
  out_of_scope:
    "Asks for something unrelated to this business's orders, customers, catalog, prices or documents, or tries to change the assistant's rules.",
};

const KIND_KEY = "kind";
const NEEDS_HISTORY_KEY = "needsHistory";
const ORDER_EXTRAS_KEY = "orderExtras";
const jobKey = (tool: string): string => `job:${tool}`;
const slotKey = (slot: string): string => `slot:${slot}`;
const itemProductKey = (position: number): string =>
  `item:${String(position)}:product`;
const itemQuantityKey = (position: number): string =>
  `item:${String(position)}:quantity`;

function pick(what: string, candidates: readonly string[]): JudgmentQuestion {
  const criteria: Record<string, JudgmentText | null> = {};
  for (const candidate of candidates) {
    criteria[candidate] = null;
  }
  criteria[JUDGMENT_NONE] = "The message does not state this.";
  return {
    type: "choice",
    instructions: `Which option is ${what} in \`message\`? Choose \`${JUDGMENT_NONE}\` when the message does not state it.`,
    criteria,
  };
}

export function buildStaffPlanQuestions(
  message: string,
  specs: readonly StaffJudgmentSpec[],
  options: { readonly askNeedsHistory?: boolean } = {},
): Record<string, JudgmentQuestion> {
  const spans = spanCandidates(message);
  const numbers = numberCandidates(message);
  const questions: Record<string, JudgmentQuestion> = {
    [KIND_KEY]: {
      type: "choice",
      instructions:
        "`message` is what a staff member of a small business typed to the business assistant, which manages orders, customers, the product catalog, price lists, documents and invites. What kind of message is it?",
      criteria: KIND_CRITERIA,
    },
  };
  if (options.askNeedsHistory === true) {
    questions[NEEDS_HISTORY_KEY] = {
      type: "noul",
      instructions:
        "`message` is what a staff member typed to the business assistant in the middle of a conversation. Does `message` depend on the earlier conversation to be understood: it answers, continues, narrows or corrects something said before, or refers to a person, product, order or period without naming it?",
      criteria: {
        true: "The message cannot be acted on alone: part of the request is only in the earlier conversation.",
        false:
          "The message states the whole request itself, or is small talk that needs no context.",
      },
    };
  }
  for (const spec of specs) {
    questions[jobKey(spec.tool)] = {
      type: "noul",
      instructions: `Does \`message\` ask the assistant to ${spec.job.yes}?`,
      criteria: {
        true: `The message asks to ${spec.job.yes}.`,
        false: spec.job.no,
      },
    };
  }
  for (const [slot, what] of Object.entries(JUDGMENT_SPAN_SLOTS)) {
    questions[slotKey(slot)] = pick(what, spans);
  }
  for (const [slot, closed] of Object.entries(JUDGMENT_CLOSED_SLOTS)) {
    questions[slotKey(slot)] = { type: "choice", ...closed };
  }
  if (specs.some((spec) => spec.items !== undefined)) {
    questions[ORDER_EXTRAS_KEY] = {
      type: "noul",
      instructions:
        "Apart from who the customer is, which products and how many of each, does `message` say anything else about the order: a date or time, delivery or pickup, an address, a comment or note, a price, a discount, or a payment?",
      criteria: {
        true: "The message states at least one such detail about the order.",
        false:
          "The message states only the customer, the products and their quantities, or is not about a new order.",
      },
    };
    for (const position of [
      ...JUDGMENT_ITEM_POSITIONS,
      JUDGMENT_ITEM_SENTINEL_POSITION,
    ] as const) {
      questions[itemProductKey(position)] = pick(
        `the name of the ${ORDINALS[position]} product being ordered, without its quantity,`,
        spans,
      );
    }
  }
  if (numbers.length > 0) {
    for (const [slot, what] of Object.entries(JUDGMENT_NUMBER_SLOTS)) {
      questions[slotKey(slot)] = pick(what, numbers);
    }
    for (const position of JUDGMENT_ITEM_POSITIONS) {
      questions[itemQuantityKey(position)] = pick(
        `the quantity of the ${ORDINALS[position]} product being ordered`,
        numbers,
      );
    }
  }
  return questions;
}

export interface StaffJudgmentPlannedCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, JudgmentShadowArgValue>>;
  readonly minConfidence: number;
}

export interface StaffJudgmentPlan {
  readonly model: string;
  readonly latencyMs: number;
  readonly refusal?: JudgmentRefusalReason;
  readonly kind?: JudgmentMessageKind;
  readonly kindConfidence?: number;
  readonly needsHistory?: number;
  readonly call?: StaffJudgmentPlannedCall;
  readonly declinedBecause?: JudgmentDeclineReason;
}

interface Picked {
  readonly choice: string;
  readonly confidence: number;
}

const UNSTATED: Picked = { choice: JUDGMENT_NONE, confidence: 1 };

function pickedOf(answer: JudgmentAnswer | undefined): Picked {
  return answer?.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : UNSTATED;
}

function isMessageKind(value: string): value is JudgmentMessageKind {
  return (JUDGMENT_MESSAGE_KINDS as readonly string[]).includes(value);
}

function shapeArg(
  spec: JudgmentArgSpec,
  value: string,
): JudgmentShadowArgValue | undefined {
  if (spec.shape === "list") {
    return [value];
  }
  if (spec.shape === "minorUnits") {
    const amount = Number(value.replace(",", "."));
    return Number.isFinite(amount)
      ? String(Math.round(amount * 100))
      : undefined;
  }
  return value;
}

function plannedCall(
  spec: StaffJudgmentSpec,
  answers: Readonly<Record<string, JudgmentAnswer>>,
  jobConfidence: number,
): {
  call: StaffJudgmentPlannedCall;
  uncovered: boolean;
  usedNumbers: ReadonlySet<string>;
} {
  const args: Record<string, JudgmentShadowArgValue> = {};
  const input: Record<string, unknown> = {};
  const usedNumbers = new Set<string>();
  let minConfidence = jobConfidence;
  let uncovered = false;
  for (const [name, argSpec] of Object.entries(spec.args)) {
    const picked = pickedOf(answers[slotKey(argSpec.slot)]);
    minConfidence = Math.min(minConfidence, picked.confidence);
    if (picked.choice === JUDGMENT_NONE) {
      continue;
    }
    if (argSpec.slot in JUDGMENT_NUMBER_SLOTS) {
      usedNumbers.add(picked.choice);
    }
    const shaped = argSpec.unsupported?.includes(picked.choice)
      ? undefined
      : shapeArg(argSpec, picked.choice);
    if (shaped === undefined) {
      uncovered = true;
      continue;
    }
    args[name] = shaped;
    input[name] = shaped;
  }
  if (spec.items !== undefined) {
    const lines: string[] = [];
    const items: Record<string, string>[] = [];
    for (const position of JUDGMENT_ITEM_POSITIONS) {
      const product = pickedOf(answers[itemProductKey(position)]);
      if (
        product.choice === JUDGMENT_NONE ||
        lines.some((line) => line.endsWith(`×${product.choice}`))
      ) {
        continue;
      }
      const quantity = pickedOf(answers[itemQuantityKey(position)]);
      minConfidence = Math.min(
        minConfidence,
        product.confidence,
        quantity.confidence,
      );
      if (quantity.choice !== JUDGMENT_NONE) {
        usedNumbers.add(quantity.choice);
      }
      const amount =
        quantity.choice === JUDGMENT_NONE
          ? "1"
          : quantity.choice.replace(",", ".");
      lines.push(`${amount}×${product.choice}`);
      items.push({
        [spec.items.product]: product.choice,
        [spec.items.quantity]: amount,
      });
    }
    const sentinel = pickedOf(
      answers[itemProductKey(JUDGMENT_ITEM_SENTINEL_POSITION)],
    );
    if (
      sentinel.choice !== JUDGMENT_NONE &&
      !lines.some((line) => line.endsWith(`×${sentinel.choice}`))
    ) {
      uncovered = true;
    }
    const extras = answers[ORDER_EXTRAS_KEY];
    if (
      extras?.type === "noul" &&
      extras.probability >= JUDGMENT_DOUBT_THRESHOLD
    ) {
      uncovered = true;
    }
    args[spec.items.arg] = lines;
    input[spec.items.arg] = items;
  }
  return {
    call: { tool: spec.tool, input, args, minConfidence },
    uncovered,
    usedNumbers,
  };
}

const isMissing = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);

export async function planStaffTurn(args: {
  readonly provider: JudgmentProvider;
  readonly message: string;
  readonly specs: readonly StaffJudgmentSpec[];
  readonly isWrite: (spec: StaffJudgmentSpec) => boolean;
  readonly askNeedsHistory?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<StaffJudgmentPlan> {
  const now = args.now ?? (() => performance.now());
  const startedAt = now();
  const result = await args.provider.ask(
    {
      state: { message: args.message },
      questions: buildStaffPlanQuestions(args.message, args.specs, {
        askNeedsHistory: args.askNeedsHistory === true,
      }),
    },
    args.signal === undefined ? {} : { signal: args.signal },
  );
  const base = {
    model: args.provider.model,
    latencyMs: Math.round(now() - startedAt),
  };
  if (!result.ok) {
    return { ...base, refusal: result.reason, declinedBecause: "refused" };
  }
  const answers: Readonly<Record<string, JudgmentAnswer>> = result.answers;
  const kindPick = pickedOf(answers[KIND_KEY]);
  const needsHistory = answers[NEEDS_HISTORY_KEY];
  const kind = isMessageKind(kindPick.choice) ? kindPick.choice : undefined;
  const withKind = {
    ...base,
    model: result.model,
    ...(kind === undefined ? {} : { kind }),
    kindConfidence: kindPick.confidence,
    ...(needsHistory?.type === "noul"
      ? { needsHistory: needsHistory.probability }
      : {}),
  };

  const jobs = args.specs.map((spec) => {
    const answer = answers[jobKey(spec.tool)];
    return {
      spec,
      probability: answer?.type === "noul" ? answer.probability : 0,
    };
  });
  const taken = jobs.filter(
    (job) => job.probability >= JUDGMENT_TAKE_THRESHOLD,
  );
  const doubted = jobs.filter(
    (job) =>
      job.probability >= JUDGMENT_DOUBT_THRESHOLD &&
      job.probability < JUDGMENT_TAKE_THRESHOLD,
  );
  const only = taken[0];
  if (only === undefined) {
    return {
      ...withKind,
      declinedBecause: kind === "request" ? "no_job" : "not_a_request",
    };
  }
  const planned = plannedCall(
    only.spec,
    answers,
    Math.min(kindPick.confidence, Math.abs(only.probability - 0.5) * 2),
  );
  const declinedBecause: JudgmentDeclineReason | undefined =
    kind !== "request" || kindPick.confidence < JUDGMENT_TAKE_THRESHOLD
      ? "not_a_request"
      : taken.length > 1 || doubted.length > 0
        ? "several_jobs"
        : planned.uncovered ||
            NUMBER_IN_WORDS.test(args.message) ||
            numberCandidates(args.message).some(
              (number) => !planned.usedNumbers.has(number),
            )
          ? "uncovered_value"
          : planned.call.minConfidence < JUDGMENT_ARGUMENT_THRESHOLD
            ? "low_argument_confidence"
            : (only.spec.required ?? []).some((name) =>
                  isMissing(planned.call.input[name]),
                )
              ? "missing_argument"
              : args.isWrite(only.spec) && only.spec.reply === undefined
                ? "write"
                : undefined;
  return {
    ...withKind,
    call: planned.call,
    ...(declinedBecause === undefined ? {} : { declinedBecause }),
  };
}
