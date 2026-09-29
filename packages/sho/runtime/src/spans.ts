import type { Bundle } from "./bundle.ts";
import { ModelError } from "./errors.ts";
import { CUSTOMER_LEADS } from "./lexicon/customers.ts";
import { argmax } from "./math.ts";
import { cardinalCuts } from "./numbers.ts";
import type { Offset } from "./tokenizer.ts";

export interface TaggedSpan {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly score: number;
}

export type BestSpans = Readonly<Record<string, string>>;

interface OpenSpan {
  readonly kind: string;
  readonly start: number;
  end: number;
  readonly scores: number[];
}

const WORD_CHAR = /[\p{L}\p{N}_'-]/u;
const DIGIT = /[0-9]/;
const NO_OFFSET: Offset = [0, 0];

export function joinsNumber(utterance: string, end: number, left: number): boolean {
  return end < left && DIGIT.test(utterance[end - 1] ?? "") && DIGIT.test(utterance[left] ?? "") && !utterance.slice(end, left).trim();
}

export function wordBounds(utterance: string, start: number, end: number): readonly [start: number, end: number] {
  let from = start;
  let to = end;
  while (from > 0 && WORD_CHAR.test(utterance[from - 1] ?? "")) from--;
  while (to < utterance.length && WORD_CHAR.test(utterance[to] ?? "")) to++;
  return [from, to];
}

function mean(scores: readonly number[]): number {
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function closed(utterance: string, open: OpenSpan): TaggedSpan | null {
  const [start, end] = wordBounds(utterance, open.start, open.end);
  const text = utterance.slice(start, end).trim();
  return text ? { kind: open.kind, start, end, text, score: mean(open.scores) } : null;
}

const DIGITS = /^[0-9]+$/;

// Two digit groups of one kind next to each other join («20 000»), unless the raw text had a comma or a stop between them (`breaks`, D70: «900, 500»):
// then they are two spans, whether the model tagged the second one B- or I- (a number is never written with a comma and a space inside it).
function commaApart(utterance: string, end: number, left: number, breaks: ReadonlySet<string> | undefined): boolean {
  if (breaks === undefined || !breaks.size || end >= left || utterance.slice(end, left).trim()) return false;
  const before = utterance.slice(0, end).split(" ").at(-1) ?? "";
  const after = utterance.slice(left).split(" ")[0] ?? "";
  return DIGITS.test(before) && DIGITS.test(after) && breaks.has(`${before} ${after}`);
}

// A token that starts inside a word: the character before it is a word character and no space parts it from the token before.
function insideWord(utterance: string, left: number, previousEnd: number | null): boolean {
  return previousEnd !== null && left === previousEnd && left > 0 && WORD_CHAR.test(utterance[left - 1] ?? "") && WORD_CHAR.test(utterance[left] ?? "");
}

// `wordTagged` (v3, D72): the training labels every subword of a span word with the span's kind, so a word is one span of one kind: its first
// subword's, or when that one is O, the kind the other subwords' tags give the most probability mass (a tag's probability summed over the subwords
// argmax gave it; O only when every subword is O). A word whose subwords flip kinds is no longer cut in two («повербанком» one product, not product +
// bank_name + product; «10» one percent), and a word whose first subword alone is O is still tagged («бра|уні»). The word keeps a first subword's I-
// (it continues the span before it), else begins B-. (A mass vote over every subword was measured too: 2 fewer live rows, as many elsewhere.)
function wordLabels(bundle: Pick<Bundle, "tags">, utterance: string, offsets: readonly Offset[], probabilities: readonly (readonly number[])[], argmaxes: number[]): number[] {
  const labels = [...argmaxes];
  let word: number[] = [];
  let previousEnd: number | null = null;
  const settle = () => {
    if (word.length < 2) return;
    const mass = new Map<string, number>();
    for (const at of word) {
      const name = bundle.tags[argmaxes[at] ?? 0] ?? "O";
      if (name !== "O") mass.set(name.slice(2), (mass.get(name.slice(2)) ?? 0) + (probabilities[at]?.[argmaxes[at] ?? 0] ?? 0));
    }
    const lead = bundle.tags[argmaxes[word[0] ?? 0] ?? 0] ?? "O";
    const kind = lead === "O" ? [...mass].reduce<[string, number] | null>((best, entry) => (best === null || entry[1] > best[1] ? entry : best), null)?.[0] : lead.slice(2);
    if (kind === undefined) return;
    const [first, ...rest] = word;
    const begin = bundle.tags[argmaxes[first ?? 0] ?? 0] === `I-${kind}` ? `I-${kind}` : `B-${kind}`;
    if (first !== undefined) labels[first] = bundle.tags.indexOf(begin);
    for (const at of rest) labels[at] = bundle.tags.indexOf(`I-${kind}`);
  };
  for (const [index, [left, right]] of offsets.entries()) {
    if (index >= argmaxes.length || left >= right) continue;
    if (!insideWord(utterance, left, previousEnd)) {
      settle();
      word = [];
    }
    word.push(index);
    previousEnd = right;
  }
  settle();
  return labels;
}

export function collectSpans(bundle: Pick<Bundle, "tags">, utterance: string, offsets: readonly Offset[], probabilities: readonly (readonly number[])[], breaks?: ReadonlySet<string>, wordTagged = false): TaggedSpan[] {
  const found = probabilities.map((row) => argmax(row));
  const argmaxes = wordTagged ? wordLabels(bundle, utterance, offsets, probabilities, found) : found;
  const spans: TaggedSpan[] = [];
  let current: OpenSpan | null = null;
  for (let index = 0; index <= argmaxes.length; index++) {
    const token = index < argmaxes.length;
    const label = token ? (argmaxes[index] ?? 0) : 0;
    const name = token ? bundle.tags[label] : "O";
    const [left, right] = index < offsets.length ? (offsets[index] ?? NO_OFFSET) : NO_OFFSET;
    if (token && left >= right) continue;
    if (name === undefined) throw new ModelError("tag_width", `tag logits have ${probabilities[index]?.length ?? 0} columns, the bundle has ${bundle.tags.length} tags`);
    const score = probabilities[index]?.[label] ?? Number.NaN;
    const kind = name.slice(2);
    const same = current !== null && name !== "O" && kind === current.kind;
    const continues = same && current !== null && (name.startsWith("I") || left === current.end || joinsNumber(utterance, current.end, left)) && !commaApart(utterance, current.end, left, breaks);
    if (continues && current !== null && left < right) {
      current.end = right;
      current.scores.push(score);
      continue;
    }
    if (current !== null) {
      const span = closed(utterance, current);
      if (span !== null) spans.push(span);
      current = null;
    }
    if (name !== "O" && left < right) current = { kind, start: left, end: right, scores: [score] };
  }
  return spans;
}

function led(span: TaggedSpan, utterance: string): boolean {
  const before = utterance.slice(0, span.start).split(/\s+/).filter(Boolean);
  return span.kind === "customer" && before.length > 0 && CUSTOMER_LEADS.has(before[before.length - 1] ?? "");
}

export function bestSpans(spans: readonly TaggedSpan[], utterance = ""): BestSpans {
  const best = new Map<string, TaggedSpan>();
  for (const span of spans) {
    const current = best.get(span.kind);
    const ahead = current === undefined || Number(led(span, utterance)) > Number(led(current, utterance)) || (led(span, utterance) === led(current, utterance) && span.score > current.score);
    if (ahead) best.set(span.kind, span);
  }
  return Object.fromEntries(Array.from(best, ([kind, span]) => [kind, span.text]));
}

// D73 (v3): a money span whose number words say two sums one after the other (`numbers.ts` `cardinalCuts`: «тисячу чотириста тисячу») is two spans, as
// the roles need them: «чек на тисячу чотириста, тисячу карткою і чотириста готівкою» is the total and a card part.
export function moneyApart(spans: readonly TaggedSpan[], kind: string): TaggedSpan[] {
  return spans.flatMap((span) => {
    if (span.kind !== kind) return [span];
    const words = Array.from(span.text.matchAll(/\S+/g), (match) => [match[0], match.index] as const);
    const cuts = cardinalCuts(words.map(([word]) => word.toLowerCase()));
    if (!cuts.length) return [span];
    const edges = [0, ...cuts, words.length];
    return edges.slice(0, -1).map((from, part) => {
      const to = edges[part + 1] ?? words.length;
      const start = words[from]?.[1] ?? 0;
      const last = words[to - 1];
      const end = last === undefined ? span.text.length : last[1] + last[0].length;
      return { ...span, start: span.start + start, end: span.start + end, text: span.text.slice(start, end) };
    });
  });
}

// D79: a name the model tagged in two pieces, the first only a preposition («створи прайс-лист для | блогерів», both `new_name`): a span of a free-text
// kind that is one such word joins the span of the same kind right after it; else only the preposition would be the name.
const FREE_TEXT_KINDS: ReadonlySet<string> = new Set(["new_name", "rename_to", "legal_name", "description", "comment", "search_text"]);
const LEAD_WORDS: ReadonlySet<string> = new Set(["для", "з", "із", "зі", "с", "со", "на", "по", "до", "від", "от", "під", "под", "без", "про", "у", "в", "во", "за", "над"]);

// D82: a comment or description the model tagged in pieces side by side («истек | срок») is one: a param takes one span, so the rest was lost.
const NOTE_KINDS: ReadonlySet<string> = new Set(["comment", "description"]);

export function leadJoined(spans: readonly TaggedSpan[], utterance: string): TaggedSpan[] {
  const out: TaggedSpan[] = [];
  for (let at = 0; at < spans.length; at++) {
    const span = spans[at];
    const next = spans[at + 1];
    if (span === undefined) continue;
    const joins = next !== undefined && FREE_TEXT_KINDS.has(span.kind) && next.kind === span.kind && LEAD_WORDS.has(span.text.toLowerCase()) && !utterance.slice(span.end, next.start).trim();
    const last = out.at(-1);
    if (last !== undefined && NOTE_KINDS.has(span.kind) && last.kind === span.kind && !utterance.slice(last.end, span.start).trim()) {
      out[out.length - 1] = { kind: span.kind, start: last.start, end: span.end, text: utterance.slice(last.start, span.end), score: Math.min(last.score, span.score) };
    } else if (joins) {
      out.push({ kind: span.kind, start: span.start, end: next.end, text: utterance.slice(span.start, next.end), score: Math.min(span.score, next.score) });
      at += 1;
    } else out.push(span);
  }
  return out;
}
