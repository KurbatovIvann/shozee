const BREAK_MARKS: readonly string[] = [":", ".", ";", "!", "?", ","];
const LABEL = String.raw`[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*`;
const EMAIL = new RegExp(String.raw`${LABEL}(?:\.${LABEL})*@${LABEL}(?:\.${LABEL})+`, "gu");
const EMAIL_MARKS: ReadonlySet<string> = new Set(["@", "."]);
const DIGIT = /[0-9]/;
const WORD = /[\p{L}\p{N}]/u;

function emailMarks(text: string, kept: Set<number>): void {
  for (const match of text.matchAll(EMAIL)) {
    for (let index = 0; index < match[0].length; index++) if (EMAIL_MARKS.has(match[0][index] ?? "")) kept.add(match.index + index);
  }
}

function decimalCommas(text: string, kept: Set<number>): void {
  for (let index = 1; index + 1 < text.length; index++) {
    if (text[index] === "," && DIGIT.test(text[index - 1] ?? "") && DIGIT.test(text[index + 1] ?? "")) kept.add(index);
  }
}

function phoneMarks(text: string, kept: Set<number>): void {
  for (let index = 0; index + 1 < text.length; index++) {
    if (text[index] === "+" && DIGIT.test(text[index + 1] ?? "") && !WORD.test(text[index - 1] ?? "")) kept.add(index);
  }
}

function keptMarks(text: string): ReadonlySet<number> {
  const kept = new Set<number>();
  emailMarks(text, kept);
  decimalCommas(text, kept);
  phoneMarks(text, kept);
  return kept;
}

function replaceMarks(text: string, marks: RegExp, by: string): string {
  const kept = keptMarks(text);
  return text.replace(marks, (mark: string, offset: number) => (kept.has(offset) ? mark : by));
}

export function normalise(text: string): string {
  const cased = text
    .replace(/(?:№|\bno\.?|\bnº)\s*(?=\d)/gi, "номер ")
    .toLowerCase()
    .replace(/[’ʼ`′´]/g, "'");
  return replaceMarks(cased, /[^\p{L}\p{N}' -]/gu, " ")
    .replace(/(^|[^\p{L}\p{N}])[-']+|[-']+(?=[^\p{L}\p{N}]|$)/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export function breakWord(token: string): string {
  return replaceMarks(token.toLowerCase().replace(/[’ʼ]/g, "'"), /[^\p{L}\p{N}_'-]/gu, "").replace(/^[-']+|[-']+$/g, "");
}

// «знижкою 10%», «10 %», «-10%»: the numbers of the raw text a percent sign follows, as the normalised text writes them (D72). The normaliser drops the
// sign (the model reads the text without it), so a span the model tags as money in a param that may be a percent is read as that percent.
export function percentMarks(raw: string | null | undefined): Set<string> {
  const tokens = (raw ?? "").split(/\s+/).filter(Boolean);
  const marked = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    const glued = /^[-+(]*([0-9]+(?:[.,][0-9]+)?)%/.exec(token);
    const apart = /^[-+(]*([0-9]+(?:[.,][0-9]+)?)$/.exec(token);
    const number = glued?.[1] ?? (apart !== null && (tokens[index + 1] ?? "").startsWith("%") ? apart[1] : undefined);
    if (number !== undefined) marked.add(number.replace(".", ","));
  }
  return marked;
}

// D82: «о 9:00», «до 18:30»: the clock times of the raw text (an hour, a colon, two digits of minutes) as the normalised text writes them («9 00»). The
// normaliser drops the colon (the model reads the text without it), so the model reads the hour and the minutes as numbers of their own: an order
// number, a sum (`decode.ts` `clockFree`). A dot is no mark here: «12.09» is a date as often as a time (D42).
const CLOCK = /(?<![\p{L}\p{N}:.,])([01]?[0-9]|2[0-3]):([0-5][0-9])(?![\p{L}\p{N}:])/gu;

export function clockMarks(raw: string | null | undefined): string[] {
  const marked: string[] = [];
  for (const found of (raw ?? "").matchAll(CLOCK)) marked.push(`${found[1] ?? ""} ${found[2] ?? ""}`);
  return marked;
}

// D82: what the raw text says that the normalised text lost, for the decoder: numbers written with a percent sign (`percentMarks`) and clock times
// (`clockMarks`).
export interface RawMarks {
  readonly percents?: ReadonlySet<string>;
  readonly clocks?: readonly string[];
}

export function rawMarks(raw: string | null | undefined): RawMarks {
  return { percents: percentMarks(raw), clocks: clockMarks(raw) };
}

// D91: is a text given as already normalised (`run({text})`) what `normalise` makes of it? It may still write what D82 reads back from a text given as
// is (`rawMarks`): «%» signs and the colon of a clock time («9:00»). They are put as `normalise` puts them — a clock's colon a space, a «%» (and one
// space on either side of it) one space, none at either end — and the rest must be `normalise`'s own output: no capitals, punctuation, apostrophe
// forms or extra spaces.
export function isNormalised(text: string): boolean {
  const marksAsNormalised = text
    .replace(CLOCK, "$1 $2")
    .replace(/(?: ?%)+ ?/g, (mark: string, offset: number, whole: string) => (offset === 0 || offset + mark.length === whole.length ? "" : " "));
  return normalise(text) === marksAsNormalised;
}

export function punctuationBreaks(raw: string | null | undefined): Set<string> {
  const tokens = (raw ?? "").split(/\s+/).filter(Boolean);
  const breaks = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const left = breakWord(token);
    const right = breakWord(tokens[index + 1] ?? "");
    if (left && right && BREAK_MARKS.some((mark) => token.replace(/[»"')]+$/, "").endsWith(mark))) breaks.add(`${left} ${right}`);
  }
  return breaks;
}
