import type { ActionName, IntentKind } from "./bundle.ts";
import { BARE_COMMAND_VERBS, COMMAND_CONNECTORS, COMMAND_VERBS, CUE_CONNECTORS, WEAK_COMMAND_VERBS } from "./lexicon/segment.ts";
import type { OrderLine } from "./lines.ts";
import type { Params, ParamValue } from "./params.ts";
import { FRAGMENT_ACTIONS } from "./references.ts";
import type { TaggedSpan } from "./spans.ts";

// D81 (sho-api-v2.md §8.12): a second command the segmenter left inside the first is never dropped silently. After a segment is read, the words from a
// command verb on («… і створи для нього замовлення …», «… і підтвердить це замовлення») that the command read holds no param of are a leftover: the
// run reads them once more as a command of their own and serves it when the model is sure of it (`pipeline.ts`), and else the command before gets a
// non-blocking need `{path: "text", reason: "unparsed", span: {text}}` («Також було: …»). A verb is a cue after a connector («і», «потім», «а також»)
// or, with none, when the model tagged a span of a record after it that the command does not hold; «і» inside a name or a line («торт з вишнею і
// маком», «Ранок і Ко») is no cue, having no verb after it. Spans alone, with no verb, are not: a command holds a period or a sum as a value its words
// do not show («за вересень» a range), and such spans would flag single commands.
//
// D95 (Q2 of the v3.5 served report): an order said after the first command with «і зроби / и сделай» («створи клієнта … і зроби для неї замовлення
// два торти») was lost on a ready card: «зроби» is no D81 verb. It is a cue after a connector when the model tagged a product after it and the command
// holds no product span at all (`WEAK_COMMAND_VERBS`). And a leftover that holds a product the command does not hold (`lines`: an order's lines) and
// is not served as a command of its own makes the `unparsed` need of a write or a destructive command blocking (`pipeline.ts` `withUnparsed`): the
// card is not ready while an order said with it is left out.

// The reason of the need a leftover gets when it is not served as a command.
export const UNPARSED = "unparsed";
// How sure the model must be of a leftover's action for the run to serve it as a command (the demo's «не впевнений» line, D74).
export const LEFTOVER_SURE = 0.5;
// The kinds of intent a leftover is served as: a read or a write, never a navigation, a card answer, a refinement or `none`.
export const LEFTOVER_KINDS: ReadonlySet<IntentKind> = new Set<IntentKind>(["read", "write", "high"]);
// Spans that say a value of a command rather than a record it names (a time, a sum, a count, an attr, free text): a command often holds one of these as
// a value the words do not show («за вересень» a range), so after a verb with no connector only another kind of span tells a second command.
const VALUE_KINDS: ReadonlySet<string> = new Set(["when", "period_span", "money", "percent", "quantity", "count", "measure", "attr", "expires", "basis", "comment", "description", "pick_text"]);
// «а також», «а потім»: «а» joins only before these.
const A_BEFORE: ReadonlySet<string> = new Set(["також", "также", "потім", "потом", "затем"]);
// D95: the span of an order line's product.
const PRODUCT = "product";

export interface Leftover {
  // Where the head ends (before the connector words) and the leftover starts (the verb), in the segment's text.
  readonly headEnd: number;
  readonly start: number;
  readonly text: string;
  // D95: the leftover holds a product the command does not hold (an order's lines): unserved, its `unparsed` need blocks.
  readonly lines: boolean;
}

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function wordsOf(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function isLine(value: unknown): value is OrderLine {
  return typeof value === "object" && value !== null && "product" in value;
}

function paramTexts(value: ParamValue): string[] {
  if (typeof value === "string") return [value];
  const texts: string[] = [];
  for (const item of value) {
    if (isLine(item)) texts.push(item.product, ...item.attrs, ...(item.quantity === undefined ? [] : [item.quantity]), ...item.said);
    else texts.push(item);
  }
  return texts;
}

// A span the command holds: its words are words of one of the command's params, in order, or a param's words are in it.
function holds(texts: readonly string[], span: TaggedSpan): boolean {
  const said = ` ${span.text.toLowerCase().trim()} `;
  return said.trim().length > 0 && texts.some((text) => text.length > 0 && (` ${text} `.includes(said) || said.includes(` ${text} `)));
}

// The first cue in `text` after which the command read (`action`, `params`) holds nothing that the model tagged (`spans`, offsets in `text`); null when
// there is none, or when the command is no command (`none`, a fragment).
export function leftoverOf(text: string, action: ActionName, params: Params, spans: readonly TaggedSpan[]): Leftover | null {
  if (FRAGMENT_ACTIONS.has(action)) return null;
  const texts = Object.values(params).flatMap(paramTexts).map((value) => value.toLowerCase().trim());
  const held = spans.filter((span) => holds(texts, span));
  const words = wordsOf(text);
  for (let index = 1; index < words.length; index++) {
    const verb = words[index];
    if (verb === undefined) continue;
    const weak = WEAK_COMMAND_VERBS.has(verb.text);
    if (!COMMAND_VERBS.has(verb.text) && !weak) continue;
    let first = index;
    while (first > 0 && CUE_CONNECTORS.has(words[first - 1]?.text ?? "")) first--;
    if (first < index && first > 0 && words[first - 1]?.text === "а" && A_BEFORE.has(words[first]?.text ?? "")) first--;
    const head = words[first - 1];
    if (head === undefined) continue;
    if (held.some((span) => span.end > verb.start)) continue;
    const joined = first < index;
    const lines = spans.some((span) => span.start > verb.start && span.kind === PRODUCT && !held.includes(span));
    // D95: «і зроби» before a product, when the command holds none.
    if (weak && (!joined || !lines || held.some((span) => span.kind === PRODUCT))) continue;
    if (!joined && !spans.some((span) => span.start > verb.start && !held.includes(span) && !VALUE_KINDS.has(span.kind))) continue;
    // «… і додай ще» said last: nothing after the verb but joining words is a command only for a verb that is one alone.
    if (words.slice(index + 1).every((word) => COMMAND_CONNECTORS.has(word.text)) && !BARE_COMMAND_VERBS.has(verb.text)) continue;
    return { headEnd: head.end, start: verb.start, text: text.slice(verb.start).trim(), lines };
  }
  return null;
}
