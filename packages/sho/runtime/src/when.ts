import { Dates } from "./dates.ts";
import { DATES } from "./lexicon/dates.ts";
import {
  AFTER_WORK,
  AFTER_WORK_TIME,
  AFTERNOON,
  AHEAD,
  AHEAD_DAYS,
  AHEAD_HOURS,
  AHEAD_MONTHS,
  BOUNDS,
  DAY_DIGIT_ENDINGS,
  DAY_ENDINGS,
  DAY_WORDS,
  END_WORDS,
  HOUR_ENDINGS,
  HOUR_WORDS,
  MONTH_DATIVES,
  MONTH_WORDS,
  MORNING,
  NEXT_WORDS,
  NOW_WORDS,
  PARTS_OF_DAY,
  RECURRING,
  RELATIVE_DAYS,
  SHOP_PM_HOURS,
  WEEK_WORDS,
  WEEKDAY_STEMS,
  WEEKEND_WORDS,
  WHEN_FILLERS,
  WITHIN,
  type Bound,
} from "./lexicon/when.ts";
import { wordNumberAt } from "./numbers.ts";

// A `when` span read (intents v3 §5.1, D66): a point or window in time a command sets or filters by, in the shop's time zone (Europe/Kyiv), past or future.
// «завтра», «в п'ятницю», «на наступну середу» (next week's), «на двадцять п'яте травня», «через дві години», «до кінця тижня», «на наступному тижні» (a
// window), clock times («о 10», «до 18:00», «на 7 вечора», «до шостої»), parts of the day («до вечора», «к обеду»). A bare hour from one to seven is after
// noon: shop hours (`SHOP_PM_HOURS`). A recurrence («щоп'ятниці») is not read. Anything the reader does not know makes the whole span unread (null): the
// host asks rather than guesses. No model tags a `when` span yet; this is the reader the v3 bundles will use.

export type { Bound } from "./lexicon/when.ts";

export interface Now {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

export interface When {
  readonly date: string | null;
  readonly time: string | null;
  readonly bound: Bound;
  readonly to?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const WEEK = 7;
const NOON = 12;
const HOURS = 24;
const MINUTES = 60;
const HALF_HOUR = 30;
// Minutes said in words after an hour start at ten: «на десять тридцать»; «на дві три» is no time.
const MINUTES_IN_WORDS = 10;
const FRIDAY = 4;
const SATURDAY = 5;
const SUNDAY = 6;
const WORD = /[\p{L}\p{N}':]+/gu;
const CLOCK = /^([0-9]{1,2}):([0-9]{2})$/;
const HOUR_PREPOSITIONS: ReadonlySet<string> = new Set(["о", "об", "в", "на", "до", "після", "после", "к", "с", "з"]);
const HALF_PAST = ["пів", "пол"];
const DATES_READER = new Dates();
const HOUR_ORDINALS: readonly (readonly [RegExp, number])[] = DATES.stems.filter(([, value]) => value <= NOON).map(([stem, value]) => [new RegExp(`^${stem}${HOUR_ENDINGS}$`), value] as const);
const DAY_ORDINALS: readonly (readonly [RegExp, number])[] = DATES.stems.map(([stem, value]) => [new RegExp(`^${stem}${DATES.endings}$`), value] as const);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function clock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function startOf(now: Now): number {
  return Date.UTC(now.year, now.month - 1, now.day);
}

function weekdayOf(time: number): number {
  return (new Date(time).getUTCDay() + WEEK - 1) % WEEK;
}

function weekday(word: string): number | null {
  const found = WEEKDAY_STEMS.findIndex((stems) => stems.some((stem) => word.startsWith(stem)));
  return found < 0 ? null : found;
}

// An hour said as an ordinal: a feminine form («шостої», «третю»), or a masculine or neuter one with an hour word after it («шестого часа»); «до
// п'ятого», «на десяте» alone are days of the month (D67).
function hourOrdinal(word: string, next: string | undefined): number | null {
  for (const [pattern, value] of HOUR_ORDINALS) {
    const ending = pattern.exec(word)?.[1];
    if (ending !== undefined) return DAY_ENDINGS.has(ending) && !HOUR_WORDS.has(next ?? "") ? null : value;
  }
  return null;
}

// A day of the month said as a masculine or neuter ordinal («п'ятнадцятого», «первому», «десяте») with no hour word after it, or as a number with
// «числа» after it («до 5 числа»); D92: or written with an ordinal ending («на 21-ше число», «до 18-го»: the words read «21», «ше»).
function dayOrdinal(word: string, next: string | undefined, after: string | undefined): boolean {
  if (HOUR_WORDS.has(next ?? "")) return false;
  if (/^[0-9]{1,2}$/.test(word)) return DAY_WORDS.has(next ?? "") || (DAY_DIGIT_ENDINGS.has(next ?? "") && !HOUR_WORDS.has(after ?? ""));
  return DAY_ORDINALS.some(([pattern]) => DAY_ENDINGS.has(pattern.exec(word)?.[1] ?? ""));
}

// The word after an hour that may say morning or evening: past an hour word («на три часа дня», «о восьмій годині вечора», D67).
function afterHour(words: readonly string[], end: number): number {
  return HOUR_WORDS.has(words[end] ?? "") ? end + 1 : end;
}

// A bare hour read as a shop means it: after noon when the words after it say so, or when it is one to seven and nothing says morning.
function shopHour(hour: number, after: string | undefined): number {
  if (after !== undefined && MORNING.has(after)) return hour;
  if (after !== undefined && AFTERNOON.has(after)) return hour < NOON ? hour + NOON : hour;
  return hour >= SHOP_PM_HOURS[0] && hour <= SHOP_PM_HOURS[1] ? hour + NOON : hour;
}

class Reading {
  readonly words: string[];
  readonly used: boolean[];
  date: number | null = null;
  to: number | null = null;
  time: string | null = null;
  bound: Bound = "at";
  readonly now: Now;
  // D72: the span says when a past event happened (`on` of an income or expense, `paid`): a weekday, a day of the month, a date or a month alone is the
  // latest one up to today, not the coming one.
  readonly past: boolean;

  constructor(text: string, now: Now, past = false) {
    this.now = now;
    this.past = past;
    this.words = Array.from(text.toLowerCase().replace(/[’ʼ`]/g, "'").replace(/ё/g, "е").matchAll(WORD), (match) => match[0]);
    this.used = this.words.map(() => false);
  }

  take(from: number, to = from + 1): void {
    for (let at = from; at < to; at++) this.used[at] = true;
  }

  get today(): number {
    return startOf(this.now);
  }

  // «до шостої», «к вечеру»: the bound said first.
  readBound(): void {
    const bound = BOUNDS.get(this.words[0] ?? "");
    if (bound === undefined) return;
    this.bound = bound;
    this.take(0);
  }

  readDays(): void {
    for (const [at, word] of this.words.entries()) {
      if (this.used[at]) continue;
      const relative = RELATIVE_DAYS.get(word);
      const day = weekday(word);
      if (NOW_WORDS.has(word)) {
        this.date = this.today;
        this.time = clock(this.now.hour, this.now.minute);
        this.take(at);
      } else if (WEEKEND_WORDS.has(word)) this.readWeekend(at);
      else if (word === WITHIN && at + 1 < this.words.length) this.readAhead(at, "by");
      else if (relative !== undefined) {
        this.date = this.today + relative * DAY_MS;
        this.take(at);
      } else if (day !== null) {
        const next = at > 0 && NEXT_WORDS.has(this.words[at - 1] ?? "");
        const ahead = (day - weekdayOf(this.today) + WEEK) % WEEK || WEEK;
        const back = (weekdayOf(this.today) - day + WEEK) % WEEK;
        this.date = next ? this.today + (WEEK - weekdayOf(this.today) + day) * DAY_MS : this.past ? this.today - back * DAY_MS : this.today + ahead * DAY_MS;
        this.take(next ? at - 1 : at, at + 1);
      } else if (NEXT_WORDS.has(word) && WEEK_WORDS.has(this.words[at + 1] ?? "")) {
        const monday = this.today + (WEEK - weekdayOf(this.today)) * DAY_MS;
        this.date = monday;
        this.to = monday + SUNDAY * DAY_MS;
        this.take(at, at + 2);
      } else if (END_WORDS.has(word)) this.readEnd(at);
      else if (word === AHEAD) this.readAhead(at);
    }
  }

  // «до кінця тижня» is by Sunday, «на кінець тижня» Friday to Sunday, «до кінця місяця» by its last day.
  readEnd(at: number): void {
    const what = this.words[at + 1] ?? "";
    if (WEEK_WORDS.has(what)) {
      const sunday = this.today + (SUNDAY - weekdayOf(this.today)) * DAY_MS;
      this.date = this.bound === "by" ? sunday : Math.max(this.today, sunday - (SUNDAY - FRIDAY) * DAY_MS);
      if (this.bound !== "by") this.to = sunday;
      this.take(at, at + 2);
    } else if (MONTH_WORDS.has(what)) {
      this.date = Date.UTC(this.now.year, this.now.month, 0);
      this.take(at, at + 2);
    }
  }

  // «на вихідні», «на выходных»: Saturday to Sunday (this weekend's on a Saturday, the next on a Sunday); «до вихідних», «к выходным»: by the Friday
  // before (D71).
  readWeekend(at: number): void {
    const today = weekdayOf(this.today);
    const saturday = this.today + (today === SUNDAY ? SUNDAY : SATURDAY - today) * DAY_MS;
    if (this.bound === "by") this.date = Math.max(this.today, saturday - DAY_MS);
    else {
      this.date = saturday;
      this.to = saturday + DAY_MS;
    }
    this.take(at);
  }

  // «через дві години», «через тиждень», «через 3 дні», «через місяць»; with «за» («за два тижні», D71) by that time.
  readAhead(at: number, bound?: Bound): void {
    const number = /^[0-9]+$/.test(this.words[at + 1] ?? "") ? ([Number(this.words[at + 1]), at + 2] as const) : wordNumberAt(this.words, at + 1);
    const [count, end] = number ?? [1, at + 1];
    const unit = this.words[end] ?? "";
    if (AHEAD_HOURS.has(unit)) {
      const moment = this.today + this.now.hour * HOUR_MS + this.now.minute * MINUTE_MS + count * HOUR_MS;
      const inDay = moment - Math.floor(moment / DAY_MS) * DAY_MS;
      this.date = Math.floor(moment / DAY_MS) * DAY_MS;
      this.time = clock(Math.floor(inDay / HOUR_MS), Math.floor((inDay % HOUR_MS) / MINUTE_MS));
    } else if (AHEAD_DAYS.has(unit)) this.date = this.today + count * (AHEAD_DAYS.get(unit) ?? 1) * DAY_MS;
    else if (AHEAD_MONTHS.has(unit)) this.date = Date.UTC(this.now.year, this.now.month - 1 + count, this.now.day);
    else return;
    if (bound !== undefined) this.bound = bound;
    this.take(at, end + 1);
  }

  // «к ноябрю», «до квітня»: a month said alone, by its first day; «в листопаді», «на ноябрь»: its days; after it, from its last day. The coming one
  // (the current month said with a bound is next year's) (D71).
  readMonth(): void {
    if (this.date !== null) return;
    for (const [at, word] of this.words.entries()) {
      const month = MONTH_DATIVES.get(word) ?? DATES_READER.month(word);
      if (this.used[at] || month === null || month === undefined) continue;
      const ahead = month > this.now.month || (month === this.now.month && this.bound === "at") ? this.now.year : this.now.year + 1;
      const year = this.past ? (month <= this.now.month ? this.now.year : this.now.year - 1) : ahead;
      const first = Date.UTC(year, month - 1, 1);
      const last = Date.UTC(year, month, 0);
      if (this.bound === "by") this.date = first;
      else if (this.bound === "after") this.date = last;
      else {
        this.date = first;
        this.to = last;
      }
      this.take(at);
      return;
    }
  }

  // «на двадцять п'яте травня», «3 жовтня»: a day and a month; this year's when it is still ahead, else next year's.
  readCalendar(): void {
    const tokens = DATES_READER.tokens(this.words.join(" "));
    for (let index = 0; index + 1 < tokens.length; index++) {
      const [kind, day, start] = tokens[index] ?? ["month", 0, 0, 0];
      const [nextKind, month, , end] = tokens[index + 1] ?? ["day", 0, 0, 0];
      if (kind !== "day" || nextKind !== "month") continue;
      const date = Date.UTC(this.now.year, month - 1, day);
      if (this.past) this.date = date <= this.today ? date : Date.UTC(this.now.year - 1, month - 1, day);
      else this.date = date >= this.today ? date : Date.UTC(this.now.year + 1, month - 1, day);
      this.takeText(start, end);
      return;
    }
  }

  // «до п'ятнадцятого», «к двадцатому», «к двадцать первому», «на десяте»: a day of the month said alone as a masculine or neuter ordinal, before the
  // clock reads its hours; this month's while it is still ahead, else next month's (D67).
  readDayOfMonth(): void {
    if (this.date !== null) return;
    const tokens = DATES_READER.tokens(this.words.join(" "));
    for (const [kind, day, start, end] of tokens) {
      const words = this.wordsIn(start, end);
      const last = words.at(-1) ?? -1;
      if (kind !== "day" || words.some((at) => this.used[at] === true) || !dayOrdinal(this.words[last] ?? "", this.words[last + 1], this.words[last + 2])) continue;
      const thisMonth = Date.UTC(this.now.year, this.now.month - 1, day);
      const month = this.past ? (thisMonth <= this.today ? this.now.month - 1 : this.now.month - 2) : thisMonth >= this.today ? this.now.month - 1 : this.now.month;
      this.date = Date.UTC(this.now.year, month, day);
      for (const at of words) this.take(at);
      // D92: the ending written after the digits («21-ше» reads «21», «ше»).
      if (/^[0-9]{1,2}$/.test(this.words[last] ?? "") && DAY_DIGIT_ENDINGS.has(this.words[last + 1] ?? "")) this.take(last + 1);
      return;
    }
  }

  // The indices of the words a character range of the joined words covers.
  wordsIn(start: number, end: number): number[] {
    const found: number[] = [];
    let offset = 0;
    for (const [at, word] of this.words.entries()) {
      if (offset >= start && offset < end) found.push(at);
      offset += word.length + 1;
    }
    return found;
  }

  // The words a character range of the joined words covers.
  takeText(start: number, end: number): void {
    for (const at of this.wordsIn(start, end)) this.take(at);
  }

  readClock(): void {
    for (const [at, word] of this.words.entries()) {
      if (this.used[at] || this.time !== null) continue;
      const written = CLOCK.exec(word);
      const before = this.words[at - 1] ?? "";
      if (written !== null && Number(written[1]) < HOURS && Number(written[2]) < MINUTES) {
        this.time = clock(Number(written[1]), Number(written[2]));
        this.takeWithBound(at, at + 1);
      } else if (HALF_PAST.includes(word) && this.words[at + 1] === "на" && hourOrdinal(this.words[at + 2] ?? "", this.words[at + 3]) !== null) {
        const end = afterHour(this.words, at + 3);
        const hour = shopHour((hourOrdinal(this.words[at + 2] ?? "", this.words[at + 3]) ?? 1) - 1, this.words[end]);
        this.time = clock(hour, HALF_HOUR);
        this.takeWithBound(at, end);
      } else if (hourOrdinal(word, this.words[at + 1]) !== null && (HOUR_PREPOSITIONS.has(before) || this.used[at - 1] === true)) {
        const [minutes, after] = this.minutesAt(at + 1);
        const end = afterHour(this.words, after);
        this.time = clock(shopHour(hourOrdinal(word, this.words[at + 1]) ?? 0, this.words[end]), minutes);
        this.takeWithBound(at, end);
      } else if (HOUR_PREPOSITIONS.has(before)) this.readHour(at);
    }
  }

  // «о 10», «на 7 вечора», «до 6», «о 10 30»: an hour said as a number after a preposition, maybe with its minutes.
  readHour(at: number): void {
    const word = this.words[at] ?? "";
    const number = /^[0-9]{1,2}$/.test(word) ? ([Number(word), at + 1] as const) : wordNumberAt(this.words, at);
    if (number === null || !Number.isInteger(number[0]) || number[0] >= HOURS) return;
    const [hour, end] = number;
    const [minutes, after] = this.minutesAt(end);
    const last = afterHour(this.words, after);
    this.time = clock(shopHour(hour, this.words[last]), minutes);
    this.takeWithBound(at, last);
  }

  // The minutes after an hour: two digits («о 10 30»), or since D71 a number said in words from ten up («на десять тридцать», «о дев'ятій сорок
  // п'ять»); none, 0.
  minutesAt(at: number): readonly [minutes: number, end: number] {
    const word = this.words[at] ?? "";
    if (/^[0-9]{2}$/.test(word) && Number(word) < MINUTES) return [Number(word), at + 1];
    const said = wordNumberAt(this.words, at);
    return said !== null && Number.isInteger(said[0]) && said[0] >= MINUTES_IN_WORDS && said[0] < MINUTES ? [said[0], said[1]] : [0, at];
  }

  takeWithBound(from: number, to: number): void {
    this.take(from, to);
    const bound = BOUNDS.get(this.words[from - 1] ?? "");
    if (bound !== undefined) {
      this.bound = bound;
      this.take(from - 1);
    }
    if (MORNING.has(this.words[to] ?? "") || AFTERNOON.has(this.words[to] ?? "")) this.take(to);
  }

  // «до вечора», «зранку», «к обеду», «після обіду»; «після роботи», «после работы» (D71).
  readPartOfDay(): void {
    for (const [at, word] of this.words.entries()) {
      const afterWork = AFTER_WORK.has(word) && BOUNDS.get(this.words[at - 1] ?? "") === "after" ? AFTER_WORK_TIME : undefined;
      const part = PARTS_OF_DAY.get(word) ?? afterWork;
      if (this.used[at] || part === undefined) continue;
      this.time ??= part;
      this.takeWithBound(at, at + 1);
    }
  }

  result(): When | null {
    const unread = this.words.some((word, at) => !this.used[at] && !WHEN_FILLERS.has(word) && !BOUNDS.has(word));
    if (unread || (this.date === null && this.time === null)) return null;
    return { date: this.date === null ? null : isoDay(this.date), time: this.time, bound: this.bound, ...(this.to === null ? {} : { to: isoDay(this.to) }) };
  }
}

function recurring(words: readonly string[]): boolean {
  return words.some((word, at) => (word.startsWith("що") && weekday(word.slice(2)) !== null) || (RECURRING.some((stem) => word.startsWith(stem)) && weekday(words[at + 1] ?? "") !== null));
}

// A `when` span as a date, a time, a bound and maybe the end of a window; null when the span says something the reader does not know.
export function parseWhen(text: string, now: Now, past = false): When | null {
  const reading = new Reading(text, now, past);
  if (!reading.words.length || recurring(reading.words)) return null;
  reading.readBound();
  reading.readDays();
  reading.readCalendar();
  reading.readDayOfMonth();
  reading.readMonth();
  reading.readClock();
  reading.readPartOfDay();
  return reading.result();
}
