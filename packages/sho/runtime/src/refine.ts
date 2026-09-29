import { intentOfAction, listItemType, type Bundle, type Intent, type ParamType } from "./bundle.ts";
import { InputError } from "./errors.ts";
import { periodDates, type Day } from "./periods.ts";
import type { CommandV2, EnumParam, Need, Param, SpanParam } from "./result.ts";
import type { Now } from "./when.ts";

// D78 (sho-api-v2.md §8.10): a follow-up that refines the previous read command («а за минулий», «а за місяць», «а для Олега», «а тільки нові»). The model
// reads the fragment alone as `ui.refine` with the filters said (intents v3.2 §4.10); the host passes the command it ran before (`RunOptions.previous`:
// the command as the runtime returned it, and when it ran), and the runtime merges the two: the previous action, each refinement param that the
// previous intent takes in place of its old value, the rest of the previous params as they were. A filter the previous intent does not take is a
// non-blocking `ignored` need. With no previous command, a previous command that is not a read, or one older than the window, the command stays
// `ui.refine` with a blocking need `previous` (the card asks «Що саме показати …?»).

export const REFINE = "ui.refine";
// Seconds a previous command stays refinable (`RuntimeOptions.refineWindow`).
export const REFINE_WINDOW = 120;
// The `period` value a bare «а за минулий» is read as (intents v3.2: the model's own value, or the words when the bundle has no such value).
export const PREVIOUS_PERIOD = "previous";

export interface Previous {
  readonly command: CommandV2;
  // When the previous command ran: a moment with a zone («2026-09-28T10:00:00Z»), a local shop time as `now` takes it («2026-09-28T13:00»), or Unix
  // milliseconds. Absent: the host vouches it is recent.
  readonly at?: string | number;
}

type Json = Readonly<Record<string, unknown>>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A command of a result as a host gives it back: its action and params are there (the rest is read as the runtime wrote it).
function isCommandJson(value: unknown): value is CommandV2 {
  return isJson(value) && typeof value["action"] === "string" && isJson(value["params"]);
}

// The previous command a host passes: an object with `command` (a command of a result: `action`, `params`, `text`, `needs`) and maybe `at`.
export function parsePrevious(value: unknown): Previous {
  if (!isJson(value)) throw new InputError("input_previous", "previous is not an object");
  const command = value["command"];
  if (!isCommandJson(command)) throw new InputError("input_previous", "previous.command has no action and params");
  const at = value["at"];
  if (at !== undefined && typeof at !== "string" && !(typeof at === "number" && Number.isFinite(at))) throw new InputError("input_previous", "previous.at is not an ISO time or Unix milliseconds");
  const given: CommandV2 = { ...command, text: typeof command.text === "string" ? command.text : "", needs: Array.isArray(command.needs) ? command.needs : [] };
  return { command: given, ...(at === undefined ? {} : { at }) };
}

// A shop time (Europe/Kyiv wall clock) as Unix milliseconds.
export function epochOf(now: Now, kyiv: (time: number) => Now): number {
  const guess = Date.UTC(now.year, now.month - 1, now.day, now.hour, now.minute);
  const seen = kyiv(guess);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
  return guess - offset;
}

type Unit = "day" | "week" | "month" | "quarter" | "year";

const LAST: Readonly<Record<Unit, string>> = { day: "yesterday", week: "last_week", month: "last_month", quarter: "last_quarter", year: "last_year" };
const THIS: Readonly<Record<Unit, string>> = { day: "today", week: "this_week", month: "this_month", quarter: "this_quarter", year: "this_year" };
// «а за місяць», «а за тиждень» (a unit with no «минулий» / «цей»): this one. By the word's start, uk and ru.
const UNIT_WORDS: readonly (readonly [stem: string, unit: Unit])[] = [
  ["місяц", "month"], ["месяц", "month"], ["тиждень", "week"], ["тижн", "week"], ["недел", "week"], ["квартал", "quarter"], ["рік", "year"], ["року", "year"],
  ["рок", "year"], ["год", "year"], ["день", "day"], ["дня", "day"], ["добу", "day"], ["сутки", "day"],
];
const PREVIOUS_WORDS: readonly string[] = ["минул", "прошл", "попередн", "предыдущ", "позамин", "позапрошл"];
const OTHER_MODIFIERS: readonly string[] = ["цей", "цього", "цьому", "этот", "этого", "этом", "поточн", "текущ", "наступн", "следующ", "сьогодн", "сегодн", "вчора", "вчера"];
const DAY_MS = 86_400_000;

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function unitOf(word: string): Unit | null {
  return UNIT_WORDS.find(([stem]) => word.startsWith(stem))?.[1] ?? null;
}

// What the words say of the period, whatever the head said: a bare «а за минулий» steps back, «а за місяць» is this month.
function spokenPeriod(text: string): "previous" | Unit | null {
  const words = wordsOf(text);
  const units = words.flatMap((word) => {
    const unit = unitOf(word);
    return unit === null ? [] : [unit];
  });
  const previous = words.some((word) => PREVIOUS_WORDS.some((stem) => word.startsWith(stem)));
  const modified = previous || words.some((word) => OTHER_MODIFIERS.some((stem) => word.startsWith(stem)));
  if (previous && !units.length) return PREVIOUS_PERIOD;
  const [unit] = units;
  return units.length === 1 && unit !== undefined && !modified && words.includes("за") ? unit : null;
}

function iso(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function utc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

const ENUM_UNITS: Readonly<Record<string, Unit>> = {
  today: "day", yesterday: "day", this_week: "week", last_week: "week", this_month: "month", last_month: "month", this_quarter: "quarter",
  last_quarter: "quarter", this_year: "year", last_year: "year",
};

// The unit a range is made of, from its days: a day, a month, a quarter or a year from its first day to its last (or to today), a week from Monday.
function unitOfDays(from: number, to: number, today: number): Unit | null {
  const start = new Date(from);
  const end = new Date(to);
  const next = new Date(to + DAY_MS);
  const closed = next.getUTCDate() === 1 || to === today;
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const first = start.getUTCDate() === 1;
  if (from === to) return "day";
  if (first && sameYear && end.getUTCMonth() === start.getUTCMonth() && closed) return "month";
  if (first && sameYear && start.getUTCMonth() % 3 === 0 && end.getUTCMonth() - start.getUTCMonth() === 2 && closed) return "quarter";
  if (first && sameYear && start.getUTCMonth() === 0 && ((end.getUTCMonth() === 11 && next.getUTCDate() === 1) || to === today)) return "year";
  if (start.getUTCDay() === 1 && (to - from) / DAY_MS <= 6 && ((to - from) / DAY_MS === 6 || to === today)) return "week";
  return null;
}

// The period one unit before `from`.
function stepped(unit: Unit, from: number): [number, number] {
  const start = new Date(from);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  switch (unit) {
    case "day":
      return [from - DAY_MS, from - DAY_MS];
    case "week":
      return [from - 7 * DAY_MS, from - DAY_MS];
    case "month":
      return [Date.UTC(year, month - 1, 1), Date.UTC(year, month, 0)];
    case "quarter":
      return [Date.UTC(year, month - 3, 1), Date.UTC(year, month, 0)];
    case "year":
      return [Date.UTC(year - 1, 0, 1), Date.UTC(year - 1, 11, 31)];
  }
}

// «а за минулий» after a period (D78): the unit the previous period is made of, one step back: this week (or today, or a range that ends today) gives
// the last one (`last_week`, `yesterday`, …), an earlier period the one before it («за липень» → June, as a range); null when the previous command had
// no period or one of no unit («за останні 10 днів»).
export function previousPeriod(value: string | undefined, today: Day): string | null {
  if (value === undefined) return null;
  const days = periodDates(value, today);
  if (days === null) return null;
  const now = Date.UTC(today.year, today.month - 1, today.day);
  const from = utc(days.from);
  const to = utc(days.to);
  const unit = Object.hasOwn(ENUM_UNITS, value) ? (ENUM_UNITS[value] ?? null) : unitOfDays(from, to, now);
  if (unit === null) return null;
  const [start, end] = stepped(unit, from);
  const last = periodDates(LAST[unit], today);
  if (last !== null && iso(start) === last.from && iso(end) === last.to) return LAST[unit];
  return `range:${iso(start)}..${iso(end)}`;
}

function isEnum(param: Param | undefined): param is EnumParam {
  return param !== undefined && !Array.isArray(param) && "value" in param && !("text" in param) && !("status" in param);
}

// The previous intent's param a refinement param fills: the same name with a type that fits, else the one param of that type.
function targetOf(bundle: Bundle, name: string, type: ParamType | undefined, previous: Intent): string | null {
  if (type === undefined) return null;
  const fits = (other: ParamType | undefined) => other !== undefined && (other === type || listItemType(bundle, other) === type || listItemType(bundle, type) === other || (listItemType(bundle, type) !== undefined && listItemType(bundle, type) === listItemType(bundle, other)));
  if (Object.hasOwn(previous.params, name) && fits(previous.params[name])) return name;
  const same = Object.entries(previous.params).filter(([, other]) => fits(other));
  const [only] = same;
  return same.length === 1 && only !== undefined ? only[0] : null;
}

// A refinement value in the shape of the param it fills: one of a list, or a list of one.
function shaped(bundle: Bundle, param: Param, type: ParamType | undefined): Param {
  const listed = type !== undefined && listItemType(bundle, type) !== undefined;
  if (listed && !Array.isArray(param)) return [param] as readonly SpanParam[];
  if (!listed && Array.isArray(param) && param.length >= 1 && typeof param[0] === "object") return param[0] as Param;
  return param;
}

function spanOf(param: Param): SpanParam | null {
  const one = Array.isArray(param) ? param[0] : param;
  return typeof one === "object" && one !== null && "text" in one && typeof one.text === "string" ? { text: one.text } : null;
}

function under(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}[`) || path.startsWith(`${name}.`) || path.split("|").includes(name);
}

function waiting(command: CommandV2): CommandV2 {
  const needs: Need[] = [...command.needs, { path: "previous", reason: "missing", blocking: true }];
  return { ...command, needs, ready: false };
}

export interface RefineClock {
  // Unix milliseconds now, and the shop's day.
  readonly time: number;
  readonly today: Day;
  // A local shop time as Unix milliseconds (`epochOf`).
  readonly epoch: (now: Now) => number;
  readonly nowOf: (text: string) => Now | null;
}

// How long ago a previous command ran, in seconds (0 when the host gave no time; infinite when its time cannot be read). D79: pronouns use it too.
export function ageOf(at: string | number | undefined, clock: RefineClock): number {
  if (at === undefined) return 0;
  if (typeof at === "number") return (clock.time - at) / 1000;
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(at.trim());
  const local = zoned ? null : clock.nowOf(at);
  const time = zoned ? Date.parse(at) : local === null ? Number.NaN : clock.epoch(local);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : (clock.time - time) / 1000;
}

// D82 (E11): a refinement's filters as `ignored` needs, for a command of the same utterance that cannot be refined (not a read).
export function ignoredNeeds(command: CommandV2): Need[] {
  return Object.entries(command.params).map(([name, param]) => {
    const span = spanOf(param);
    return { path: name, reason: "ignored", blocking: false, ...(span === null ? {} : { span }) };
  });
}

// The refinement merged into the previous command; any other command as it is.
export function refined(bundle: Bundle, command: CommandV2, previous: Previous | null, clock: RefineClock, window: number = REFINE_WINDOW): CommandV2 {
  if (command.action !== REFINE) return command;
  if (previous === null) return waiting(command);
  const before = previous.command;
  const known = Object.hasOwn(bundle.intents, before.action) && before.action !== REFINE ? intentOfAction(bundle, before.action).intent : null;
  const age = ageOf(previous.at, clock);
  if (known === null || known.kind !== "read" || !(age <= window)) return waiting(command);
  const own = intentOfAction(bundle, REFINE).intent;
  const params: Record<string, Param> = { ...before.params };
  const replaced = new Set<string>();
  const added: Need[] = [];
  const said = spokenPeriod(command.text);
  const refinement: Record<string, Param> = { ...command.params };
  const periodValues = bundle.enums["period"] ?? [];
  if (said !== null && Object.hasOwn(known.params, "period")) {
    if (said === PREVIOUS_PERIOD) refinement["period"] = { value: PREVIOUS_PERIOD };
    else if (periodValues.includes(THIS[said]) || !periodValues.length) refinement["period"] = { value: THIS[said] };
  }
  for (const [name, param] of Object.entries(refinement)) {
    const target = targetOf(bundle, name, own.params[name], known);
    if (target === null) {
      const span = spanOf(param);
      added.push({ path: name, reason: "ignored", blocking: false, ...(span === null ? {} : { span }) });
      continue;
    }
    replaced.add(target);
    if (isEnum(param) && param.value === PREVIOUS_PERIOD) {
      const old = params[target];
      const value = previousPeriod(isEnum(old) ? old.value : undefined, clock.today);
      if (value === null) {
        delete params[target];
        added.push({ path: target, reason: "missing", blocking: true });
      } else params[target] = { value };
      continue;
    }
    params[target] = shaped(bundle, param, known.params[target]);
    added.push(...command.needs.filter((need) => under(need.path, name)).map((need) => ({ ...need, path: target + need.path.slice(name.length) })));
  }
  const needs = [...before.needs.filter((need) => ![...replaced].some((name) => under(need.path, name))), ...added];
  return { ...before, text: command.text, params, needs, ready: !needs.some((need) => need.blocking), refPrevious: {}, confidence: command.confidence, refines: before.text };
}
