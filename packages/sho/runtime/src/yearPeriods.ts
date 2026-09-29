import { Dates, type RangePeriod } from "./dates.ts";
import { MONTH_LENGTHS } from "./lexicon/dates.ts";
import { HALF_WORDS, NINE_MONTHS, QUARTER_ORDINALS, QUARTER_WORD, RELATIVE_YEARS, THREE_QUARTERS, YEAR_WORDS } from "./lexicon/periods.ts";
import type { Day } from "./periods.ts";

// The v3 period ranges (intents v3 §5.3, D69): a numbered quarter («за третій квартал» 07-01..09-30), a half-year («перше півріччя» 01-01..06-30), the
// cumulative «9 місяців» / «три квартали» (01-01..09-30), each of them, a month («вересень 2025») and a whole year («за 2025 рік», «за позаминулий рік»)
// with a spoken year. Without a year a range is `range:MM-DD..MM-DD`, the latest that has started (as months are, D19); with one it is
// `range:YYYY-MM-DD..YYYY-MM-DD`, which lifts D57's "no spoken year" for the v3 bundles only.

const DATES = new Dates();
const YEAR = /^(?:19|20)[0-9]{2}$/;
const QUARTER_MONTHS = 3;
const HALF_MONTHS = 6;
const NINE = 9;
const DECEMBER = 12;
const ROMAN = ["i", "ii", "iii", "iv"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[’ʼ`]/g, "'").split(/[\s,.;:!?«»"()]+/).filter(Boolean);
}

function ordinalAt(words: readonly string[], at: number): number | null {
  const word = (words[at] ?? "").replace(/-(й|го|е|ий|ій)$/, "");
  if (/^[1-4]$/.test(word)) return Number(word);
  const roman = ROMAN.indexOf(word);
  if (roman >= 0) return roman + 1;
  return QUARTER_ORDINALS.find(([stem]) => word.startsWith(stem))?.[1] ?? null;
}

function yearWordAt(words: readonly string[], at: number): boolean {
  return YEAR_WORDS.some((year) => (words[at] ?? "").startsWith(year));
}

// The year said: four digits with a year word after them or a month, a quarter or «за» before them («за 2025 рік», «вересень 2025», «за 2025»; an order
// number «замовлення 2025» is none), or a relative year word before a year word («позаминулий рік», «минулого року»), which needs the run's day
// (`relative` false: a year said by its number only, D82).
function yearOf(words: readonly string[], today: Day, relative = true): number | null {
  for (const [index, word] of words.entries()) {
    const short = yearWordAt(words, index + 1) ? shortYear(words, index) : null;
    if (short !== null) return short;
    const before = words[index - 1] ?? "";
    if (YEAR.test(word) && (yearWordAt(words, index + 1) || before === "за" || before.startsWith(QUARTER_WORD) || DATES.month(before) !== null)) return Number(word);
    const place = relative ? RELATIVE_YEARS.find(([stem]) => word.startsWith(stem)) : undefined;
    if (place !== undefined && Number.isFinite(today.year) && yearWordAt(words, index + 1)) return today.year + place[1];
  }
  return null;
}

// «25-го року», «двадцять п'ятого року», ru «25-го года» (D72): a two-digit year said as an ordinal right before a year word, of this century.
const SHORT_YEAR = /^([0-9]{2})-(?:го|й|ий|ій|ом|ому)$/;
const CENTURY = 2000;
const SHORT_YEAR_FROM = 10;

function shortYear(words: readonly string[], index: number): number | null {
  const written = SHORT_YEAR.exec(words[index] ?? "");
  if (written !== null) return CENTURY + Number(written[1]);
  const said = DATES.tokens(words.slice(Math.max(0, index - 1), index + 1).join(" ")).at(-1);
  const spoken = said !== undefined && said[0] === "day" && said[3] === words.slice(Math.max(0, index - 1), index + 1).join(" ").length ? said[1] : null;
  return spoken !== null && spoken >= SHORT_YEAR_FROM ? CENTURY + spoken : null;
}

// The first and last month of the part of a year the words name, or null.
function monthsOf(words: readonly string[]): readonly [first: number, last: number] | null {
  const joined = ` ${words.join(" ")} `;
  if ([...NINE_MONTHS, ...THREE_QUARTERS].some((phrase) => joined.includes(` ${phrase} `))) return [1, NINE];
  for (const [index, word] of words.entries()) {
    if (word.startsWith(QUARTER_WORD)) {
      const quarter = ordinalAt(words, index - 1) ?? ordinalAt(words, index + 1);
      if (quarter !== null) return [(quarter - 1) * QUARTER_MONTHS + 1, quarter * QUARTER_MONTHS];
    }
    if (HALF_WORDS.some((half) => word.startsWith(half))) {
      const half = ordinalAt(words, index - 1);
      if (half === 1 || half === 2) return [(half - 1) * HALF_MONTHS + 1, half * HALF_MONTHS];
    }
  }
  const months = DATES.tokens(words.join(" ")).filter(([kind]) => kind === "month");
  const only = months[0];
  return months.length === 1 && only !== undefined ? [only[1], only[1]] : null;
}

// The range a v3 `period_span` (or the utterance) names; null when it names no quarter, half, nine months, month with a year or year. D82: a span that
// names months and no year takes a year the rest of the utterance says by its number («за третій квартал | 25-го року», the span cut before the year
// word); a relative year word there («цього року») is left as before.
export function yearPeriod(text: string | null | undefined, today: Day, utterance: string | null = null): RangePeriod | null {
  if (!text) return null;
  const words = wordsOf(text);
  const found = monthsOf(words);
  const year = yearOf(words, today) ?? (found !== null && utterance !== null ? yearOf(wordsOf(utterance), today, false) : null);
  const named = found !== null && (year !== null || found[0] !== found[1]);
  const months = named ? found : year !== null ? ([1, DECEMBER] as const) : null;
  if (months === null) return null;
  const [first, last] = months;
  const end = `${pad(last)}-${pad(MONTH_LENGTHS[last - 1] ?? 31)}`;
  return year === null ? `range:${pad(first)}-01..${end}` : `range:${year}-${pad(first)}-01..${year}-${end}`;
}

// D72: ranges that need the run's day, or that the one-period readers above do not know, uk and ru: «з першого вересня по сьогодні» (that day to
// today), «за першу половину вересня» (the 1st to the 15th; the second half the 16th to the month's end), «за серпень і вересень» (two months or more
// said with «і» / «та», «з липня по вересень», «квітень-червень», «липень серпень вересень»: the first's first day to the last's last day), «за півроку» / «полгода» (the last six months, to today: a range with years, as a
// rolling period has no calendar name).
const TODAY_WORDS: ReadonlySet<string> = new Set(["сьогодні", "сегодня", "сьодня", "седня"]);
const UNTIL_WORDS: ReadonlySet<string> = new Set(["по", "до"]);
const HALF_OF: readonly string[] = ["половин"];
const HALF_YEAR: ReadonlySet<string> = new Set(["півроку", "полгода", "полугода"]);
const HALF_PREFIX: ReadonlySet<string> = new Set(["пів", "пол"]);
const MONTH_JOINERS: ReadonlySet<string> = new Set(["і", "й", "та", "и", "за", "по", "до"]);
const MIDDLE_DAY = 15;
const HALF_YEAR_MONTHS = 6;

function monthDay(month: number, day: number): string {
  return `${pad(month)}-${pad(day)}`;
}

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function rollingPeriod(text: string | null | undefined, today: Day): RangePeriod | null {
  if (!text) return null;
  const words = wordsOf(text);
  const joined = words.join(" ");
  const tokens = DATES.tokens(joined);
  const known = Number.isFinite(today.year);
  const untilToday = words.some((word, at) => TODAY_WORDS.has(word) && UNTIL_WORDS.has(words[at - 1] ?? ""));
  if (untilToday && known) {
    const start = tokens.findIndex(([kind], at) => kind === "day" && tokens[at + 1]?.[0] === "month");
    const day = tokens[start];
    const month = tokens[start + 1];
    if (day !== undefined && month !== undefined && (month[1] < today.month || (month[1] === today.month && day[1] <= today.day))) return `range:${monthDay(month[1], day[1])}..${monthDay(today.month, today.day)}`;
  }
  for (const [index, word] of words.entries()) {
    if (!HALF_OF.some((stem) => word.startsWith(stem))) continue;
    const half = ordinalAt(words, index - 1);
    const month = DATES.month(words[index + 1] ?? "");
    if ((half === 1 || half === 2) && month !== null) {
      const last = MONTH_LENGTHS[month - 1] ?? 31;
      return half === 1 ? `range:${monthDay(month, 1)}..${monthDay(month, MIDDLE_DAY)}` : `range:${monthDay(month, MIDDLE_DAY + 1)}..${monthDay(month, last)}`;
    }
  }
  const months = tokens.filter(([kind]) => kind === "month");
  const first = months[0];
  const last = months.at(-1);
  if (months.length > 1 && first !== undefined && last !== undefined && !tokens.some(([kind]) => kind === "day") && first[1] < last[1]) {
    const between = joined.slice(first[3], last[2]).split(/[\s-]+/).filter((word) => word && DATES.month(word) === null);
    if (between.every((word) => MONTH_JOINERS.has(word))) return `range:${monthDay(first[1], 1)}..${monthDay(last[1], MONTH_LENGTHS[last[1] - 1] ?? 31)}`;
  }
  const halfYear = words.some((word, at) => HALF_YEAR.has(word) || (HALF_PREFIX.has(word) && YEAR_WORDS.includes(words[at + 1] ?? "")));
  if (halfYear && known && !words.some((word, at) => HALF_WORDS.some((half) => word.startsWith(half)) && ordinalAt(words, at - 1) !== null)) {
    const end = Date.UTC(today.year, today.month - 1, today.day);
    const start = Date.UTC(today.year, today.month - 1 - HALF_YEAR_MONTHS, today.day + 1);
    return `range:${isoDate(start)}..${isoDate(end)}`;
  }
  return null;
}

// D82: the range a period's words name by a year said as a number («за 2025 рік», «за третій квартал 25-го року») or by «9 місяців» / «три квартали»,
// which beats a relative value the period head chose (`this_year` for «за 2025 рік» in 2026, `this_month` for «за 9 місяців»); null for anything else,
// a relative year word («минулого року») included, which the head's value says. «за останні 9 місяців» is the last nine months, not these.
const LAST_WORDS = /(?:^| )(?:останн|последн)\S* (?:9|дев'ять|девять) /u;

export function spokenYearPeriod(text: string | null | undefined, today: Day, utterance: string | null = null): RangePeriod | null {
  if (!text) return null;
  const words = wordsOf(text);
  const joined = ` ${words.join(" ")} `;
  const nine = [...NINE_MONTHS, ...THREE_QUARTERS].some((phrase) => joined.includes(` ${phrase} `)) && !LAST_WORDS.test(joined);
  const said = yearOf(words, today, false) ?? (utterance === null || monthsOf(words) === null ? null : yearOf(wordsOf(utterance), today, false));
  return nine || said !== null ? yearPeriod(text, today, utterance) : null;
}
