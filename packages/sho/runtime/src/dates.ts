import { DATES, MONTH_LENGTHS, SEASONS, type DatesSpec } from "./lexicon/dates.ts";

export type RangePeriod = `range:${string}..${string}`;

export type Period =
  | "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "this_year" | "last_year" | "this_quarter" | "last_quarter"
  | RangePeriod | `last_days:${number}`;

export type Span = readonly [start: number, end: number];

export interface PeriodMatch {
  readonly value: RangePeriod;
  readonly span: Span;
}

type DateWord = readonly [word: string, start: number, end: number];

export type DateToken = readonly [kind: "day" | "month", value: number, start: number, end: number];

function pad(value: number | undefined): string {
  return String(value).padStart(2, "0");
}

export class Dates {
  private readonly word: RegExp;
  private readonly ordinals: readonly (readonly [RegExp, number])[];
  private readonly tens: ReadonlyMap<string, number>;
  private readonly months: ReadonlyMap<string, number>;

  constructor(spec: DatesSpec = DATES) {
    this.word = new RegExp(spec.word, "g");
    this.ordinals = spec.stems.map(([stem, value]) => [new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${spec.endings}$`), value] as const);
    this.tens = new Map(Object.entries(spec.tens));
    this.months = new Map(Object.entries(spec.months));
  }

  words(text: string): DateWord[] {
    return Array.from(text.matchAll(this.word), (match) => [match[0], match.index, match.index + match[0].length] as const);
  }

  ordinal(word: string): number | null {
    if (/^\d+$/.test(word) && Number(word) >= 1 && Number(word) <= 31) return Number(word);
    for (const [pattern, value] of this.ordinals) if (pattern.test(word)) return value;
    return null;
  }

  month(word: string): number | null {
    return this.months.get(word) ?? null;
  }

  tokens(text: string): DateToken[] {
    const words = this.words(text);
    const found: DateToken[] = [];
    let index = 0;
    while (index < words.length) {
      const current = words[index];
      if (current === undefined) break;
      const [word, start, end] = current;
      const tens = this.tens.get(word);
      if (tens !== undefined) {
        const next = words[index + 1];
        const following = next !== undefined ? this.ordinal(next[0]) : null;
        if (next !== undefined && following !== null && following < 10) {
          found.push(["day", tens + following, start, next[2]]);
          index += 2;
          continue;
        }
        found.push(["day", tens, start, end]);
      } else if (this.ordinal(word) !== null) {
        found.push(["day", this.ordinal(word) ?? 0, start, end]);
      } else if (this.month(word) !== null) {
        found.push(["month", this.month(word) ?? 0, start, end]);
      }
      index += 1;
    }
    return found;
  }

  parseRange(text: string): PeriodMatch | null {
    const tokens = this.tokens(text);
    const days = tokens.map((token, index) => (token[0] === "day" ? index : -1)).filter((index) => index >= 0);
    if (days.length < 2) return null;
    const [first = 0, second = 0] = days;
    const monthAfter = (position: number, limit?: number): number | null => {
      for (const [kind, value] of tokens.slice(position + 1, limit)) {
        if (kind === "month") return value;
        if (kind === "day") return null;
      }
      return null;
    };
    const lastMonthAfter = (position: number): number | null => {
      for (const [kind, value] of tokens.slice(position + 1)) if (kind === "month") return value;
      return null;
    };
    const endMonth = monthAfter(second) || lastMonthAfter(first);
    const startMonth = monthAfter(first, second) || endMonth;
    if (!startMonth || !endMonth) return null;
    const tail = tokens.slice(first);
    const involved = tail.filter((token) => token[0] === "day").slice(0, 2).concat(tail.filter((token) => token[0] === "month").slice(0, 2));
    const span: Span = [Math.min(...involved.map((token) => token[2])), Math.max(...involved.map((token) => token[3]))];
    return { value: `range:${pad(startMonth)}-${pad(tokens[first]?.[1])}..${pad(endMonth)}-${pad(tokens[second]?.[1])}`, span };
  }

  parseDay(text: string): PeriodMatch | null {
    const tokens = this.tokens(text);
    for (let index = 0; index + 1 < tokens.length; index++) {
      const current = tokens[index];
      const next = tokens[index + 1];
      if (current === undefined || next === undefined) continue;
      const [kind, day, start] = current;
      const [nextKind, month, , end] = next;
      if (kind === "day" && nextKind === "month") return { value: `range:${pad(month)}-${pad(day)}..${pad(month)}-${pad(day)}`, span: [start, end] };
    }
    return null;
  }

  parseMonth(text: string): PeriodMatch | null {
    const tokens = this.tokens(text);
    const months = tokens.filter((token) => token[0] === "month");
    const only = months[0];
    if (months.length !== 1 || only === undefined || tokens.some((token) => token[0] === "day")) return null;
    const [, month, start, end] = only;
    const last = MONTH_LENGTHS[month - 1];
    return { value: `range:${pad(month)}-01..${pad(month)}-${pad(last)}`, span: [start, end] };
  }

  // «за літо», «за лето»: a season is its three months (D66); winter runs from December to February. A season with a month or a day said is no season.
  parseSeason(text: string): PeriodMatch | null {
    if (this.tokens(text).length) return null;
    for (const [word, start, end] of this.words(text)) {
      const season = SEASONS.get(word);
      if (season === undefined) continue;
      const [first, last] = season;
      return { value: `range:${pad(first)}-01..${pad(last)}-${pad(MONTH_LENGTHS[last - 1])}`, span: [start, end] };
    }
    return null;
  }

  parsePeriod(text: string): PeriodMatch | null {
    return this.parseRange(text) || this.parseDay(text) || this.parseMonth(text) || this.parseSeason(text);
  }

  rangeValue(utterance: string | null | undefined, span: string | null | undefined): RangePeriod | null {
    for (const text of [span, utterance]) {
      const parsed = text ? this.parsePeriod(text) : null;
      if (parsed) return parsed.value;
    }
    return null;
  }
}
