import type { ActionName, IntentKind } from "./bundle.ts";
import type { Confidence } from "./confidence.ts";
import type { Resolved, ResolvedName } from "./customers.ts";
import { canonicalNumber } from "./numbers.ts";
import type { LineValue, Value, Values } from "./params.ts";
import type { Inference } from "./pipeline.ts";
import type { CommandV2, DebugV2, EnumParam, OrderItem, Param, Quantity, Ref, ResultV2, SpanParam, VariantParam } from "./result.ts";

// Result v1, the output before D65: params as spans (order lines with one `variant` string), `values` and `resolved` beside them. `toV1` is the only way
// it is made now: the conformance vectors, the Python evaluations and older hosts read it (docs/design/sho-api-v2.md §1).

export interface OrderLineV1 {
  readonly product: string;
  readonly quantity?: string;
  readonly variant?: string;
}

export type ParamValueV1 = string | readonly OrderLineV1[] | readonly string[];
export type ParamsV1 = Readonly<Record<string, ParamValueV1>>;

export interface Command {
  readonly text: string;
  readonly action: ActionName;
  readonly kind: IntentKind;
  readonly params: ParamsV1;
  readonly values: Values;
  readonly resolved: Resolved;
  readonly refPrevious: Readonly<Record<string, number>>;
  readonly catalogued: boolean;
  readonly confidence: Confidence;
  readonly debug?: Inference;
}

export interface Result {
  readonly raw: string | null;
  readonly text: string;
  readonly segments: readonly string[];
  readonly tooMany: boolean;
  readonly first: Command;
  readonly commands: readonly Command[];
  readonly debug?: DebugV2;
}

// v1 `resolved` held only customer names: the one customer, and each name of a customer list (D56, D58).
const RESOLVED_V1: ReadonlySet<string> = new Set(["customer", "customers"]);

function everyItem(param: Param, key: string): boolean {
  if (!Array.isArray(param)) return false;
  const items: readonly unknown[] = param;
  return items.every((item) => typeof item === "object" && item !== null && key in item);
}

function isItems(param: Param): param is readonly OrderItem[] {
  return everyItem(param, "product");
}

function isRefs(param: Param): param is readonly Ref[] {
  return !isItems(param) && everyItem(param, "status");
}

function isVariant(param: Param): param is VariantParam {
  return !Array.isArray(param) && "attrs" in param;
}

function isRef(param: Param): param is Ref {
  return !Array.isArray(param) && "status" in param && !("attrs" in param);
}

function isSpan(param: Param): param is SpanParam {
  return !Array.isArray(param) && "text" in param && !("status" in param);
}

// v3 (D69): a list of values («money_list», «measure_list», «city_list»).
function isSpans(param: Param): param is readonly SpanParam[] {
  return !isItems(param) && !isRefs(param) && everyItem(param, "text");
}

// v3.1 (D75): a list of enum values (`tax`); v1 writes the same list.
function isValues(param: Param): param is readonly string[] {
  return Array.isArray(param) && param.every((item: unknown) => typeof item === "string");
}

function isEnum(param: Param): param is EnumParam {
  return !Array.isArray(param) && !("text" in param);
}

// A quantity as v1 wrote it: the span, else the number in digits with the unit said (a D60 sum «5 кг», one of a spread count «1»).
export function quantityText(quantity: Quantity): string | undefined {
  if (quantity.implicit === true) return undefined;
  if (quantity.text !== null) return quantity.text;
  return [canonicalNumber(quantity.value ?? 0), ...(quantity.unitText === null ? [] : [quantity.unitText])].join(" ");
}

function lineV1(item: OrderItem): OrderLineV1 {
  const quantity = quantityText(item.quantity);
  const variant = item.attrs.map((attr) => attr.text).join(" ");
  return { product: item.product.text, ...(quantity === undefined ? {} : { quantity }), ...(variant ? { variant } : {}) };
}

function paramV1(param: Param): ParamValueV1 | null {
  if (isValues(param)) return param;
  if (isItems(param)) return param.map(lineV1);
  if (isRefs(param)) return param.map((ref) => ref.text);
  if (isSpans(param)) return param.map((span) => span.text);
  if (isRef(param)) return param.status === "previous" ? null : param.text;
  if (isVariant(param) || isSpan(param)) return param.text;
  return isEnum(param) ? param.value : null;
}

function itemValues(items: readonly OrderItem[]): LineValue[] | null {
  const values: LineValue[] = items.map((item) => (item.quantity.implicit === true ? {} : { quantity: item.quantity.value }));
  return values.some((line) => line.quantity !== undefined && line.quantity !== null) ? values : null;
}

// A v3 value (D69) has no v1 form but money, which v1 wrote in hryvnias as `valueOf` reads a v2 `price` or `amount`.
function valueV1(param: Param): Value | null {
  if (isItems(param)) return itemValues(param);
  if (!isSpan(param) || param.value === undefined) return null;
  const value = param.value;
  if (typeof value !== "object") return value;
  return "minor" in value ? value.minor / 100 : null;
}

function resolvedV1(param: Param): ResolvedName | null {
  if (isRefs(param)) {
    const names = param.map((ref) => (ref.status === "resolved" ? (ref.name ?? null) : null));
    return names.some((name) => name !== null) ? names : null;
  }
  return isRef(param) && param.status === "resolved" ? (param.name ?? null) : null;
}

export function commandV1(command: CommandV2): Command {
  const params: Record<string, ParamValueV1> = {};
  const values: Record<string, Value> = {};
  const resolved: Record<string, ResolvedName> = {};
  for (const [name, param] of Object.entries(command.params)) {
    const found = paramV1(param);
    if (found === null) continue;
    params[name] = found;
    const value = valueV1(param);
    if (value !== null) values[name] = value;
    const known = RESOLVED_V1.has(name) ? resolvedV1(param) : null;
    if (known !== null) resolved[name] = known;
  }
  const { action, margin, certainty } = command.confidence;
  const v1: Command = { text: command.text, action: command.action, kind: command.kind, params, values, resolved, refPrevious: command.refPrevious, catalogued: command.catalogued, confidence: { action, margin, certainty } };
  return command.debug === undefined ? v1 : { ...v1, debug: command.debug };
}

export function toV1(result: ResultV2): Result {
  const v1: Result = { raw: result.raw, text: result.text, segments: result.segments, tooMany: result.tooMany, first: commandV1(result.first), commands: result.commands.map(commandV1) };
  return result.debug === undefined ? v1 : { ...v1, debug: result.debug };
}
