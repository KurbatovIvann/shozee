import { ORDER_LINES, isV3, listHeadOf, listItemType, type Bundle, type EnumKey, type ParamType } from "./bundle.ts";
import { Dates } from "./dates.ts";
import { ModelError } from "./errors.ts";
import { pairLines, type OrderLine } from "./lines.ts";
import { argmax } from "./math.ts";
import { lastDays, valueOf } from "./numbers.ts";
import type { BestSpans, TaggedSpan } from "./spans.ts";
import type { Now } from "./when.ts";
import { rollingPeriod, spokenYearPeriod, yearPeriod } from "./yearPeriods.ts";

export type ParamValue = string | readonly OrderLine[] | readonly string[];
export type Params = Readonly<Record<string, ParamValue>>;
export interface LineValue {
  readonly quantity?: number | null;
}
export type Value = number | string | readonly LineValue[];
export type Values = Readonly<Record<string, Value>>;

export type EnumLogits = Readonly<Record<EnumKey, ArrayLike<number>>>;

export type ParamBundle = Pick<Bundle, "colliding" | "enumTypes" | "enums" | "lineFields" | "listTypes" | "rangeSpan" | "catalogue" | "listEnums" | "listHeads" | "listThresholds">;

export const DATE_PARSER = new Dates();

export function headKey(bundle: Pick<Bundle, "colliding">, name: string, type: ParamType): EnumKey {
  return bundle.colliding.has(type) ? name : type;
}

export function lastDaysValue(utterance: string, span: string | null | undefined): `last_days:${number}` | null {
  for (const text of [span, utterance]) {
    const found = text ? lastDays(text) : null;
    if (found) return `last_days:${found[0]}`;
  }
  return null;
}

export function isLines(value: ParamValue | undefined): value is readonly OrderLine[] {
  return value !== undefined && typeof value !== "string" && value.every((item) => typeof item !== "string");
}

export function isNames(value: ParamValue | undefined): value is readonly string[] {
  return value !== undefined && typeof value !== "string" && value.every((item) => typeof item === "string");
}

export function listValue(spans: readonly TaggedSpan[], kind: string): string[] {
  const found: string[] = [];
  for (const span of spans) if (span.kind === kind && !found.includes(span.text)) found.push(span.text);
  return found;
}

// A v3 range (D69): a quarter, a half-year, «9 місяців» or a spoken year from the period span, else the utterance, else the v2 reader. A year said by its
// place («позаминулий рік») needs the run's day; without one it is not read.
// D72: then the ranges `rollingPeriod` reads («з першого вересня по сьогодні», «першу половину вересня», «серпень і вересень», «за півроку»), before the
// v2 reader, which reads «першого вересня» alone as one day.
function rangeV3(utterance: string, span: string | undefined, now: Now | null): string | null {
  const today = now ?? { year: Number.NaN, month: 1, day: 1 };
  return yearPeriod(span, today, utterance) ?? rollingPeriod(span, today) ?? yearPeriod(utterance, today) ?? rollingPeriod(utterance, today) ?? DATE_PARSER.rangeValue(utterance, span);
}

// D82: the period head's relative values a year said as a number or «9 місяців» overrides (`spokenYearPeriod`); `previous` (a refinement's «а за
// минулий»), `range` and `last_days` read the words already.
const RELATIVE_PERIODS: ReadonlySet<string> = new Set(["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"]);

function saidRange(utterance: string, span: string | undefined, now: Now | null): string | null {
  const today = now ?? { year: Number.NaN, month: 1, day: 1 };
  return spokenYearPeriod(span, today, utterance) ?? spokenYearPeriod(utterance, today);
}

// v3.1 (D75): a list of enum values (`tax`) is every value of its head whose sigmoid reaches the value's threshold, in the head's order; none over
// its threshold is no value (the param is absent: `tax` is optional in both of its intents, and a row that names no tax trains an empty set).
export function listEnumValue(bundle: Pick<Bundle, "listHeads" | "listThresholds">, key: EnumKey, logits: ArrayLike<number> | undefined): string[] {
  const values = bundle.listHeads[key] ?? [];
  if (logits === undefined) throw new ModelError("list_head", `heads lack list head ${key}`);
  if (logits.length !== values.length) throw new ModelError("output_width", `list_${key} has ${logits.length} values, the bundle expects ${values.length}`);
  const thresholds = bundle.listThresholds[key] ?? [];
  return values.filter((_, index) => 1 / (1 + Math.exp(-(logits[index] ?? Number.NEGATIVE_INFINITY))) >= (thresholds[index] ?? 0.5));
}

export function paramValue(
  bundle: ParamBundle,
  name: string,
  type: ParamType,
  utterance: string,
  spans: readonly TaggedSpan[],
  best: BestSpans,
  enums: EnumLogits,
  now: Now | null = null,
  lists: EnumLogits = {},
): ParamValue | null | undefined {
  if (type === ORDER_LINES) return pairLines(bundle, spans, utterance);
  const listHead = listHeadOf(bundle, type);
  if (listHead !== undefined) return listEnumValue(bundle, listHead, lists[listHead]);
  const item = listItemType(bundle, type);
  if (item !== undefined) return listValue(spans, item);
  if (!bundle.enumTypes.has(type)) return best[type];
  const key = headKey(bundle, name, type);
  const logits = enums[key];
  if (logits === undefined) throw new ModelError("enum_head", `heads lack enum head ${key}`);
  const value = bundle.enums[key]?.[argmax(logits)];
  // D72: a v3 head that says one of `range` / `last_days` while the words say the other («за три дні» read as a range, «за півроку» as last days) gets
  // what the words say.
  if (value === "range") return isV3(bundle) ? (rangeV3(utterance, best[bundle.rangeSpan], now) ?? lastDaysValue(utterance, best[bundle.rangeSpan])) : DATE_PARSER.rangeValue(utterance, best[bundle.rangeSpan]);
  if (value === "last_days") return lastDaysValue(utterance, best[bundle.rangeSpan]) ?? (isV3(bundle) ? rangeV3(utterance, best[bundle.rangeSpan], now) : null);
  if (value !== undefined && isV3(bundle) && RELATIVE_PERIODS.has(value)) return saidRange(utterance, best[bundle.rangeSpan], now) ?? value;
  return value;
}

export function present(value: ParamValue | null | undefined): value is ParamValue {
  return typeof value === "string" ? Boolean(value) : value !== null && value !== undefined && value.length > 0;
}

function quantityValue(text: string): number | null {
  const value = valueOf("quantity", text);
  return typeof value === "number" ? value : null;
}

function lineValues(lines: readonly OrderLine[]): LineValue[] | null {
  const values: LineValue[] = lines.map((line) => (line.quantity ? { quantity: quantityValue(line.quantity) } : {}));
  return values.some((line) => line.quantity !== undefined && line.quantity !== null) ? values : null;
}

export function paramValues(types: Readonly<Record<string, ParamType>>, params: Params): Values {
  const values: Record<string, Value> = {};
  for (const [name, value] of Object.entries(params)) {
    const type = Object.hasOwn(types, name) ? types[name] : undefined;
    const found = type === ORDER_LINES ? (isLines(value) ? lineValues(value) : null) : valueOf(type ?? "", value);
    if (found !== null) values[name] = found;
  }
  return values;
}
