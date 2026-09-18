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
export const JUDGMENT_ITEM_POSITIONS = [1, 2, 3] as const;

const ORDINALS = { 1: "first", 2: "second", 3: "third" } as const;
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
    for (const position of JUDGMENT_ITEM_POSITIONS) {
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
  readonly args: Readonly<Record<string, JudgmentShadowArgValue>>;
  readonly minConfidence: number;
}

export interface StaffJudgmentPlan {
  readonly model: string;
  readonly latencyMs: number;
  readonly refusal?: JudgmentRefusalReason;
  readonly kind?: JudgmentMessageKind;
  readonly kindConfidence?: number;
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
): { call: StaffJudgmentPlannedCall; uncovered: boolean } {
  const args: Record<string, JudgmentShadowArgValue> = {};
  let minConfidence = jobConfidence;
  let uncovered = false;
  for (const [name, argSpec] of Object.entries(spec.args)) {
    const picked = pickedOf(answers[slotKey(argSpec.slot)]);
    minConfidence = Math.min(minConfidence, picked.confidence);
    if (picked.choice === JUDGMENT_NONE) {
      continue;
    }
    const shaped = argSpec.unsupported?.includes(picked.choice)
      ? undefined
      : shapeArg(argSpec, picked.choice);
    if (shaped === undefined) {
      uncovered = true;
      continue;
    }
    args[name] = shaped;
  }
  if (spec.items !== undefined) {
    const lines: string[] = [];
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
      lines.push(
        `${quantity.choice === JUDGMENT_NONE ? "1" : quantity.choice}×${product.choice}`,
      );
    }
    args[spec.items.arg] = lines;
  }
  return { call: { tool: spec.tool, args, minConfidence }, uncovered };
}

export async function planStaffTurn(args: {
  readonly provider: JudgmentProvider;
  readonly message: string;
  readonly specs: readonly StaffJudgmentSpec[];
  readonly isWrite: (spec: StaffJudgmentSpec) => boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<StaffJudgmentPlan> {
  const now = args.now ?? (() => performance.now());
  const startedAt = now();
  const result = await args.provider.ask(
    {
      state: { message: args.message },
      questions: buildStaffPlanQuestions(args.message, args.specs),
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
  const kind = isMessageKind(kindPick.choice) ? kindPick.choice : undefined;
  const withKind = {
    ...base,
    model: result.model,
    ...(kind === undefined ? {} : { kind }),
    kindConfidence: kindPick.confidence,
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
        : planned.uncovered || NUMBER_IN_WORDS.test(args.message)
          ? "uncovered_value"
          : planned.call.minConfidence < JUDGMENT_ARGUMENT_THRESHOLD
            ? "low_argument_confidence"
            : args.isWrite(only.spec)
              ? "write"
              : undefined;
  return {
    ...withKind,
    call: planned.call,
    ...(declinedBecause === undefined ? {} : { declinedBecause }),
  };
}
