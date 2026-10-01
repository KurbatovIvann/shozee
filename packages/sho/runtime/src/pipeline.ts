import { intentOfAction, type ActionName, type Bundle, type EnumKey } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import { commandV2, type Decision, type Requirements } from "./command.ts";
import { tempered } from "./confidence.ts";
import type { Resolved } from "./customers.ts";
import { resolveCustomer } from "./customers.ts";
import { decode, type Decoded, type Heads } from "./decode.ts";
import { InputError } from "./errors.ts";
import { asHowTo, howToQuestion } from "./howTo.ts";
import { answersCard, foreignLanguage, languageCommand, namesRecord } from "./language.ts";
import { LEFTOVER_KINDS, LEFTOVER_SURE, UNPARSED, leftoverOf, type Leftover } from "./leftover.ts";
import { headsOf, type ModelRunner } from "./model.ts";
import type { Params } from "./params.ts";
import { nameAcross } from "./lists.ts";
import { withCreates, withFocus, type FocusEntry } from "./focus.ts";
import { fromPrevious } from "./pronouns.ts";
import { FRAGMENT_ACTIONS, fillReferences, lostCommand, type NameOf, type References, type Segment } from "./references.ts";
import { RESULT_SCHEMA, type CommandV2, type ContextInfo, type Need, type ResultV2 } from "./result.ts";
import { REFINE, REFINE_WINDOW, epochOf, ignoredNeeds, refined, type Previous, type RefineClock } from "./refine.ts";
import { MAX_COMMANDS, segmentStarts, splitCommands } from "./segment.ts";
import type { BestSpans, TaggedSpan } from "./spans.ts";
import { isNormalised, normalise, percentMarks, punctuationBreaks, rawMarks, type RawMarks } from "./text/normalise.ts";
import { Tokenizer, type Encoding, type Offset } from "./tokenizer.ts";
import type { Now } from "./when.ts";

export interface Timing {
  readonly tokenise: number;
  readonly model: number;
  readonly decode: number;
  readonly total: number;
}

export interface Inference {
  readonly text: string;
  readonly ids: readonly number[];
  readonly offsets: readonly Offset[];
  readonly heads: Heads;
  readonly spans: readonly TaggedSpan[];
  readonly best: BestSpans;
  readonly actionProbabilities: readonly number[];
  readonly tagProbabilities: readonly (readonly number[])[];
  readonly enumProbabilities: Readonly<Record<EnumKey, readonly number[]>>;
  readonly timing: Timing;
}

// `raw`: recognised speech as the recogniser gave it, always (normalised here, its punctuation, «%» and clock times read). `text`: a text already
// normalised (tests, evaluation); D91: one `normalise` would change is an InputError `text_not_normalised`.
export type Input = { readonly raw: string } | { readonly text: string };

export interface RunOptions {
  readonly context?: CompiledContext | null;
  readonly debug?: boolean;
  // The moment a v3 `when` span is read against, in the shop's time zone (D69); by default the runtime's clock in Europe/Kyiv. A v2 bundle reads none.
  readonly now?: Now;
  // D78: the command the host ran before this utterance (as the runtime returned it) and when: a refinement («а за минулий», `ui.refine`) is merged
  // into it (`refine.ts`).
  readonly previous?: Previous | null;
  // D88: the records the host keeps in focus, newest first (`focus.ts`, `parseFocus`): a reference word («для неї», «туди», «цю групу») binds to the one
  // live entry of its param's type that agrees (D90: by the conversation's turns, never a clock), asks when several fit, offers one only a one-tap
  // check may take, asks when none does, and a create command says what it `creates`. Absent (null): the pronouns read `previous` as D79 does.
  readonly focus?: readonly FocusEntry[] | null;
}

export interface HeldPass {
  readonly text: string;
  readonly heads: Heads;
}

export interface RuntimeOptions {
  // Timings only (`debug`, `Timing`): a monotonic clock such as `performance.now()` is fine here.
  readonly clock?: () => number;
  // The wall clock `now` is read from when a run gives none (D72): Unix milliseconds, by default `Date.now`. Never the timing clock, whose zero is the
  // process start (every date read against it was in January 1970).
  readonly wallClock?: () => number;
  // What the intent catalogue requires of each action's params (`parseRequirements`): a command without them gets a blocking `missing` need.
  readonly requirements?: Requirements;
  // D78: how many seconds a previous command stays refinable (`RunOptions.previous`); 120 by default.
  readonly refineWindow?: number;
  // D87: the temperature of the action head (the bundle's `calibration.json`, `parseCalibration`); 1 by default. It changes only the commands'
  // `confidence`: the actions, the leftover rule (D81) and `debug` read the model's own probabilities.
  readonly actionTemperature?: number;
}

// Results are v2 (D65); `toV1` (`v1.ts`) makes the v1 form from one.
export interface Runtime {
  readonly bundle: Bundle;
  run(input: Input, options?: RunOptions): Promise<ResultV2>;
  decode(text: string, heads: Heads, context?: CompiledContext | null, breaks?: ReadonlySet<string>, now?: Now | null): CommandV2;
  decodeResult(text: string, heads: Heads, passes: readonly HeldPass[], context?: CompiledContext | null, now?: Now | null, previous?: Previous | null, focus?: readonly FocusEntry[] | null): ResultV2;
  segmentsOf(text: string, heads: Heads): readonly string[];
  tokenize(text: string): Encoding;
}

interface Pass {
  readonly decoded: Decoded;
  readonly inference: Inference;
}

interface Part extends Segment {
  readonly pass: Pass;
  readonly spans?: readonly TaggedSpan[];
}

// D81: a piece of the utterance served as one command: its text, the pass it was read from and, for the head of a segment cut before a leftover, the
// spans of that pass before the cut.
interface Piece {
  readonly text: string;
  readonly pass: Pass;
  readonly spans?: readonly TaggedSpan[];
}

// D95: the effects of a card a left-out order blocks.
const WRITES: ReadonlySet<string> = new Set(["write", "destructive"]);

interface Filled {
  readonly action: ActionName;
  readonly params: Params;
  readonly resolved: Resolved;
  readonly refPrevious: References;
}

function customerNames(context: CompiledContext | null): NameOf {
  return (span) => (context === null ? null : (resolveCustomer(span, span, context.customers)?.name ?? null));
}

const KYIV = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });

// The shop's wall clock (Europe/Kyiv) at a Unix time in milliseconds.
export function kyivNow(time: number): Now {
  const parts = Object.fromEntries(KYIV.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  const number = (name: string) => Number(parts[name] ?? Number.NaN);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour") % 24, minute: number("minute") };
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;
// A date said with no time is read at noon, as the data validator's anchor is (`sho/data/multidomain/values.py` `ANCHOR_TIME`).
const ANCHOR_HOUR = 12;

// `now` from an ISO string (D72: the CLI's `--now`, a row's `now`): a moment with a zone («2026-09-27T05:29:55Z», «…+03:00») is taken to Europe/Kyiv; a
// local date or date and time («2026-09-27», «2026-09-27T10:00») is the shop's wall clock as written. Null when it is neither.
export function nowOf(text: string): Now | null {
  const local = LOCAL_TIME.exec(text.trim());
  if (local !== null) {
    const [year, month, day] = [Number(local[1]), Number(local[2]), Number(local[3])];
    const hour = local[4] === undefined ? ANCHOR_HOUR : Number(local[4]);
    const minute = local[5] === undefined ? 0 : Number(local[5]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) return null;
    return { year, month, day, hour, minute };
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text.trim())) return null;
  const time = Date.parse(text.trim());
  return Number.isNaN(time) ? null : kyivNow(time);
}

function contextInfo(context: CompiledContext | null): ContextInfo | null {
  return context === null ? null : { version: context.records.shop.version, revision: context.records.shop.revision };
}

export function createRuntime(bundle: Bundle, runner: ModelRunner, options: RuntimeOptions = {}): Runtime {
  const tokenizer = new Tokenizer(bundle.tokenizer, bundle);
  const clock = options.clock ?? Date.now;
  const wallClock = options.wallClock ?? Date.now;
  const requirements = options.requirements ?? {};
  const refineWindow = options.refineWindow ?? REFINE_WINDOW;
  const temperature = options.actionTemperature ?? 1;

  // The clock a refinement is timed by: the run's `now` when it pins one, else the wall clock.
  function refineClock(now: Now | null, pinned: boolean): RefineClock {
    const day = now ?? kyivNow(wallClock());
    return { time: pinned && now !== null ? epochOf(now, kyivNow) : wallClock(), today: { year: day.year, month: day.month, day: day.day }, epoch: (local) => epochOf(local, kyivNow), nowOf };
  }

  function decisionOf(text: string, decoded: Decoded, inference: Inference | null, spans: readonly TaggedSpan[], now: Now | null, fill: Filled = { ...decoded, refPrevious: {} }, percents: readonly string[] = []): Decision {
    const asks = decoded.asks === undefined || fill.action !== decoded.action ? {} : { asks: decoded.asks };
    const unsupported = decoded.unsupported === undefined || fill.action !== decoded.action ? {} : { unsupported: decoded.unsupported };
    const dropped = decoded.dropped === undefined || fill.action !== decoded.action ? {} : { dropped: decoded.dropped };
    const ignored = decoded.ignored === undefined ? {} : { ignored: decoded.ignored };
    const decision: Decision = { text, ...fill, catalogued: decoded.catalogued, actionProbabilities: tempered(decoded.actionProbabilities, temperature), spans, ...(decoded.aux === undefined ? {} : { aux: decoded.aux }), ...asks, ...unsupported, ...dropped, ...ignored, ...(percents.length ? { percents } : {}), now };
    return inference === null ? decision : { ...decision, debug: inference };
  }

  function passOf(text: string, { ids, offsets }: Encoding, heads: Heads, decoded: Decoded, timing: Timing): Pass {
    const { spans, best, actionProbabilities, tagProbabilities, enumProbabilities } = decoded;
    return { decoded, inference: { text, ids, offsets, heads, spans, best, actionProbabilities, tagProbabilities, enumProbabilities, timing } };
  }

  async function infer(text: string, context: CompiledContext | null, breaks: ReadonlySet<string>, now: Now, marks: RawMarks = {}): Promise<Pass> {
    const started = clock();
    const encoding = tokenizer.encode(text);
    const tokenised = clock();
    const outputs = await runner.run(encoding.ids);
    const ran = clock();
    const heads = headsOf(bundle, outputs, encoding.ids.length);
    const decoded = decode(bundle, text, encoding.offsets, heads, context, breaks, now, marks);
    const done = clock();
    return passOf(text, encoding, heads, decoded, { tokenise: tokenised - started, model: ran - tokenised, decode: done - ran, total: done - started });
  }

  function held(text: string, heads: Heads, context: CompiledContext | null, now: Now | null): Pass {
    const encoding = tokenizer.encode(text);
    return passOf(text, encoding, heads, decode(bundle, text, encoding.offsets, heads, context, new Set(), now), { tokenise: 0, model: 0, decode: 0, total: 0 });
  }

  function segmentsOf(text: string, heads: Heads): readonly string[] {
    return heads.segment === null ? [text] : splitCommands(text, segmentStarts(text, tokenizer.encode(text).offsets, heads.segment));
  }

  function wantsPasses(segments: readonly string[]): boolean {
    return segments.length > 1 && segments.length <= MAX_COMMANDS;
  }

  // The model's spans of the passes a command was read from: a command merged from several segments (D28, D58) holds each of their texts.
  function spansOf(text: string, passes: readonly Pass[]): TaggedSpan[] {
    return passes.filter((pass) => text.includes(pass.inference.text)).flatMap((pass) => pass.decoded.spans);
  }

  // What a first pass and its segments' passes serve (D79 `nameAcross`: a cut inside a record's name is no second command): the whole first pass, or
  // the segments' passes.
  function servedPieces(text: string, first: Pass, segments: readonly string[], passes: readonly Pass[], context: CompiledContext | null): Piece[] {
    const parts: Part[] = passes.map((pass) => ({ text: pass.inference.text, action: pass.decoded.action, params: pass.decoded.params, resolved: pass.decoded.resolved, pass }));
    const filled = fillReferences(bundle, parts, customerNames(context));
    const whole = segments.length === 1 || lostCommand(parts, filled, first.decoded) || nameAcross(bundle, first.decoded.action, first.decoded.params, text, segments, context);
    return whole ? [{ text, pass: first }] : passes.map((pass) => ({ text: pass.inference.text, pass }));
  }

  // D81: each piece's text to the words its command holds nothing of, from a command verb on (`leftover.ts`).
  function leftovers(pieces: readonly Piece[]): Map<string, Leftover> {
    const found = new Map<string, Leftover>();
    for (const piece of pieces) {
      const left = leftoverOf(piece.text, piece.pass.decoded.action, piece.pass.decoded.params, piece.spans ?? piece.pass.decoded.spans);
      if (left !== null) found.set(piece.text, left);
    }
    return found;
  }

  // D81: a leftover read as a command of its own is served when the model is sure of it and it is a read or a write.
  function sure(pass: Pass): boolean {
    return LEFTOVER_KINDS.has(intentOfAction(bundle, pass.decoded.action).intent.kind) && Math.max(...pass.decoded.actionProbabilities) >= LEFTOVER_SURE;
  }

  // A refinement merged into a command of its own utterance: both texts, and no `refines` (that names a command of an earlier result).
  function inUtterance(merged: CommandV2, text: string): CommandV2 {
    const { refines: _refines, ...command } = merged;
    return { ...command, text };
  }

  // D95: a leftover with an order's lines (a product the command does not hold) blocks a write's card: it is not ready while that order is left out.
  function withUnparsed(command: CommandV2, unparsed: ReadonlyMap<string, Leftover>): CommandV2 {
    const left = unparsed.get(command.text);
    if (left === undefined) return command;
    const blocking = left.lines && WRITES.has(command.effect);
    const need: Need = { path: "text", reason: UNPARSED, blocking, span: { text: left.text } };
    return { ...command, needs: [...command.needs, need], ...(blocking ? { ready: false } : {}) };
  }

  function assembled(raw: string | null, text: string, first: Pass, segments: readonly string[], passes: readonly Pass[], context: CompiledContext | null, debug: boolean, now: Now | null, previous: Previous | null = null, pinned = true, recovered: readonly Piece[] | null = null, focus: readonly FocusEntry[] | null = null): ResultV2 {
    const percents = [...percentMarks(raw)];
    const pieces = recovered ?? servedPieces(text, first, segments, passes, context);
    // A bundle with no segment head reads one command per utterance (v2c and before): nothing is a leftover.
    const unparsed = first.inference.heads.segment === null ? new Map<string, Leftover>() : leftovers(pieces);
    // A recovered piece's spans are its own pass's (or, for a head that kept its first reading, those before the cut).
    const read: readonly Piece[] = recovered?.map((piece) => ({ ...piece, spans: piece.spans ?? piece.pass.decoded.spans })) ?? passes.map((pass) => ({ text: pass.inference.text, pass }));
    const parts: Part[] = read.map((piece) => ({ text: piece.text, action: piece.pass.decoded.action, params: piece.pass.decoded.params, resolved: piece.pass.decoded.resolved, pass: piece.pass, ...(piece.spans === undefined ? {} : { spans: piece.spans }) }));
    const firstDecision = decisionOf(text, first.decoded, debug ? first.inference : null, first.decoded.spans, now, undefined, percents);
    const filled = fillReferences(bundle, parts, customerNames(context));
    const whole = recovered === null && pieces.length === 1 && pieces[0]?.pass === first;
    const decisions = whole ? [firstDecision] : filled.map((part) => decisionOf(part.text, part.pass.decoded, debug ? part.pass.inference : null, part.spans ?? spansOf(part.text, passes), now, part, percents));
    const clock = refineClock(now, pinned);
    // D79: a pronoun takes its record from the previous command (`pronouns.ts`); D88: with a focus from the host, a reference word takes its record from
    // the focus (`focus.ts`) and `previous` is only what a refinement merges into.
    const withPrevious = (decision: Decision): Decision => {
      if (focus !== null) return withFocus(bundle, decision, focus);
      const refs = fromPrevious(bundle, decision, previous, clock, refineWindow);
      return Object.keys(refs).length ? { ...decision, fromPrevious: refs } : decision;
    };
    const creating = (command: CommandV2): CommandV2 => (focus === null ? command : withCreates(command));
    // D97: a question about the app («як мені …», «що таке …», «де в застосунку …») is served as `none` with the `how_to` need (`howTo.ts`).
    const build = (decision: Decision) => creating(asHowTo(bundle, withUnparsed(refined(bundle, commandV2(bundle, withPrevious(decision), context, requirements), previous, clock, refineWindow), unparsed)));
    // D82 (E11): a refinement said right after another command of the same utterance («відкрий форму нового прайсу | в chrome») refines that command,
    // not the host's previous one: merged into it when it is a read, else its filters are `ignored` needs on it; it gets no card of its own. A
    // question about the app (D97) is no refinement of it.
    const commands: CommandV2[] = [];
    for (const decision of decisions) {
      const before = commands.at(-1);
      if (before === undefined || decision.action !== REFINE || howToQuestion(decision.text) !== null) {
        commands.push(build(decision));
        continue;
      }
      const own = commandV2(bundle, withPrevious(decision), context, requirements);
      const merged = refined(bundle, own, { command: before }, clock, refineWindow);
      commands[commands.length - 1] = merged.action === REFINE ? { ...before, needs: [...before.needs, ...ignoredNeeds(own)] } : inUtterance(merged, `${before.text} ${own.text}`);
    }
    const served = recovered === null ? segments : recovered.map((piece) => piece.text);
    return { schema: RESULT_SCHEMA, raw, text, segments: served, tooMany: served.length > MAX_COMMANDS, commands, first: build(firstDecision), context: contextInfo(context) };
  }

  // D81: a leftover read once more as a command of its own and served when the model is sure of it, the segment cut before it and read again; at
  // most MAX_COMMANDS commands. Null when nothing was cut.
  async function recover(pieces: readonly Piece[], context: CompiledContext | null, breaks: ReadonlySet<string>, now: Now, extra: Pass[], marks: RawMarks): Promise<Piece[] | null> {
    const found = [...pieces];
    let cut = false;
    for (let index = 0; index < found.length && found.length < MAX_COMMANDS; index++) {
      const piece = found[index];
      if (piece === undefined) continue;
      const spans = piece.spans ?? piece.pass.decoded.spans;
      const left = leftoverOf(piece.text, piece.pass.decoded.action, piece.pass.decoded.params, spans);
      if (left === null) continue;
      const tail = await infer(left.text, context, breaks, now, marks);
      extra.push(tail);
      if (!sure(tail)) continue;
      // The head is read again without the leftover, as the segmenter would have cut it («створи замовлення … і пробий чек» is an order and a
      // receipt, not a receipt); a head read as no command keeps its first reading, its spans before the cut.
      const text = piece.text.slice(0, left.headEnd).trim();
      const reread = await infer(text, context, breaks, now, marks);
      extra.push(reread);
      const head: Piece = FRAGMENT_ACTIONS.has(reread.decoded.action) ? { text, pass: piece.pass, spans: spans.filter((span) => span.end <= left.headEnd) } : { text, pass: reread };
      found.splice(index, 1, head, { text: tail.inference.text, pass: tail });
      cut = true;
    }
    return cut ? found : null;
  }

  async function run(input: Input, runOptions: RunOptions = {}): Promise<ResultV2> {
    const started = clock();
    const raw = "raw" in input ? input.raw : null;
    const text = "raw" in input ? normalise(input.raw) : input.text;
    if (!text) throw new InputError("empty_input", "the input is empty after normalisation");
    // D91: `{text}` is a text already normalised (tests, evaluation); recognised speech is `{raw}`. A text `normalise` would change («Шерлока», a
    // comma) would be read as it is written and resolve nothing, so it is refused, not read.
    if (raw === null && !isNormalised(text)) throw new InputError("text_not_normalised", `the text is not normalised (normalised: «${normalise(text)}»); pass recognised speech as {raw}`);
    const breaks = raw === null ? new Set<string>() : punctuationBreaks(raw);
    const context = runOptions.context ?? null;
    const debug = runOptions.debug === true;
    const now = runOptions.now ?? kyivNow(wallClock());
    // D82: the percent signs and clock times the normalised text lost (`rawMarks`); a text given as is may still write them.
    const marks = rawMarks(raw ?? text);
    // D93: no Cyrillic word is no utterance of ours (`language.ts`): one `none` command with the `language` need, the model not read (with `debug`, it
    // is read for the diagnostics only). The addendum: a short answer to a card the previous command left asking, or a record's whole name, is read.
    const exempt = (): boolean => answersCard(text, runOptions.previous ?? null) || namesRecord(text, context);
    const foreign = foreignLanguage(raw ?? text) && !exempt() ? languageCommand(bundle, text) : null;
    if (foreign !== null) {
      const served: ResultV2 = { schema: RESULT_SCHEMA, raw, text, segments: [text], tooMany: false, commands: [foreign], first: foreign, context: contextInfo(context) };
      if (!debug) return served;
      const read = await infer(text, context, breaks, now, marks);
      const shown = { ...foreign, debug: read.inference };
      return { ...served, commands: [shown], first: shown, debug: { first: read.inference, passes: [], total: clock() - started } };
    }
    const first = await infer(text, context, breaks, now, marks);
    const segmentLogits = first.inference.heads.segment;
    const segments = segmentLogits === null ? [text] : splitCommands(text, segmentStarts(text, first.inference.offsets, segmentLogits));
    const passes: Pass[] = [];
    if (wantsPasses(segments)) for (const segment of segments) passes.push(await infer(segment, context, breaks, now, marks));
    const extra: Pass[] = [];
    const recovered = segmentLogits === null || segments.length > MAX_COMMANDS ? null : await recover(servedPieces(text, first, segments, passes, context), context, breaks, now, extra, marks);
    const result = assembled(raw, text, first, segments, passes, context, debug, now, runOptions.previous ?? null, runOptions.now !== undefined, recovered, runOptions.focus ?? null);
    return debug ? { ...result, debug: { first: first.inference, passes: [...passes, ...extra].map((pass) => pass.inference), total: clock() - started } } : result;
  }

  function decodeText(text: string, heads: Heads, context: CompiledContext | null = null, breaks: ReadonlySet<string> = new Set(), now: Now | null = kyivNow(wallClock())): CommandV2 {
    const decoded = decode(bundle, text, tokenizer.encode(text).offsets, heads, context, breaks, now);
    return commandV2(bundle, decisionOf(text, decoded, null, decoded.spans, now), context, requirements);
  }

  function decodeResult(text: string, heads: Heads, given: readonly HeldPass[], context: CompiledContext | null = null, now: Now | null = kyivNow(wallClock()), previous: Previous | null = null, focus: readonly FocusEntry[] | null = null): ResultV2 {
    const first = held(text, heads, context, now);
    const segments = segmentsOf(text, heads);
    const expected = wantsPasses(segments) ? segments : [];
    if (given.length !== expected.length || given.some((pass, index) => pass.text !== expected[index])) throw new InputError("input_passes", `passes must be the ${expected.length} segment(s) of the first pass, in order`);
    return assembled(null, text, first, segments, given.map((pass) => held(pass.text, pass.heads, context, now)), context, false, now, previous, true, null, focus);
  }

  return { bundle, run, decode: decodeText, decodeResult, segmentsOf, tokenize: (text) => tokenizer.encode(text) };
}
