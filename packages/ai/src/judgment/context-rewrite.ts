import type { JudgmentShadowArgValue } from "@showzy/validation/assistant-judgment";
import { isInflectionOfWord } from "@showzy/validation/entity-ref";
import { generateText, type LanguageModel } from "ai";

import {
  JUDGMENT_CLOSED_SLOTS,
  type StaffJudgmentSpec,
} from "../tool-facades/judgment-specs.js";

export interface JudgmentExchange {
  readonly user: string;
  readonly assistant: string;
}

export const CONTEXT_REWRITE_EXCHANGES_MAX = 3;
export const CONTEXT_REWRITE_OUTPUT_TOKENS_MAX = 300;

export const CONTEXT_REWRITE_SYSTEM_PROMPT = [
  "You prepare the latest message of a staff member of a small Ukrainian business for a downstream classifier that sees only that one message and none of the conversation.",
  "Rewrite the latest message as one self-contained Ukrainian request. Resolve pronouns and 'the same' from the conversation, and carry over what the message relies on but does not repeat: the job, the period, the order status, the customer, the products, quantities and prices.",
  "When the latest message answers the assistant's question, write the full request the answer completes.",
  "Keep names of people, groups, products and price lists exactly as written in the conversation. Write numbers as digits and put a quantity directly before its product.",
  "If the latest message already stands on its own, return it unchanged. Invent nothing. Output only the rewritten message.",
].join("\n");

export function contextRewriteTranscript(
  exchanges: readonly JudgmentExchange[],
  message: string,
): string {
  const lines = exchanges
    .slice(-CONTEXT_REWRITE_EXCHANGES_MAX)
    .flatMap((exchange) => [
      `Staff: ${exchange.user}`,
      `Assistant: ${exchange.assistant}`,
    ]);
  return [
    "Conversation so far:",
    lines.length === 0 ? "(none)" : lines.join("\n"),
    "",
    "Latest message:",
    message,
  ].join("\n");
}

export async function rewriteWithConversation(args: {
  readonly model: LanguageModel;
  readonly exchanges: readonly JudgmentExchange[];
  readonly message: string;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  try {
    const result = await generateText({
      model: args.model,
      system: CONTEXT_REWRITE_SYSTEM_PROMPT,
      prompt: contextRewriteTranscript(args.exchanges, args.message),
      maxOutputTokens: CONTEXT_REWRITE_OUTPUT_TOKENS_MAX,
      maxRetries: 0,
      ...(args.signal === undefined ? {} : { abortSignal: args.signal }),
    });
    const text = result.text.trim();
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

const wordsOf = (text: string): string[] =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

const digitsOf = (text: string): string => text.replaceAll(/\D/g, "");

function isGroundedWord(word: string, source: readonly string[]): boolean {
  return source.some(
    (other) =>
      other === word ||
      isInflectionOfWord(word, other) ||
      isInflectionOfWord(other, word),
  );
}

export function isExtensionOfTyped(typed: string, made: string): boolean {
  const madeWords = wordsOf(made);
  const typedWords = wordsOf(typed);
  return (
    typedWords.length > 0 &&
    typedWords.length < madeWords.length &&
    typedWords.every((word) => isGroundedWord(word, madeWords))
  );
}

function spokenValues(
  spec: StaffJudgmentSpec,
  args: Readonly<Record<string, JudgmentShadowArgValue>>,
): string[] {
  const names = Object.entries(spec.args)
    .filter(
      ([, arg]) => arg.shape === "text" && !(arg.slot in JUDGMENT_CLOSED_SLOTS),
    )
    .map(([name]) => name);
  const lines = spec.items === undefined ? undefined : args[spec.items.arg];
  return [
    ...names.flatMap((name) => {
      const value = args[name];
      return typeof value === "string" ? [value] : [];
    }),
    ...(Array.isArray(lines)
      ? lines.map((line) => line.slice(line.indexOf("×") + 1))
      : []),
  ];
}

export function isRewriteGrounded(args: {
  readonly spec: StaffJudgmentSpec;
  readonly callArgs: Readonly<Record<string, JudgmentShadowArgValue>>;
  readonly rewritten: string;
  readonly conversation: readonly string[];
}): boolean {
  const source = args.conversation.flatMap(wordsOf);
  const sourceDigits = args.conversation.map(digitsOf);
  const numbersGrounded = (args.rewritten.match(/\d+/gu) ?? []).every((run) =>
    sourceDigits.some((digits) => digits.includes(run)),
  );
  return (
    numbersGrounded &&
    spokenValues(args.spec, args.callArgs).every((value) =>
      wordsOf(value).every(
        (word) => /^\d+$/u.test(word) || isGroundedWord(word, source),
      ),
    )
  );
}
