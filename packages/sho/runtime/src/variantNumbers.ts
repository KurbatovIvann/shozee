import { ORDER_LINES, type Intent } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { OrderLine } from "./lines.ts";
import { numberWordKind, ordinalValue } from "./numbers.ts";
import { isLines, type ParamValue, type Params } from "./params.ts";
import { productRef } from "./resolve.ts";

// D73: a number said right after an order line that one of the line's product's variants holds is that variant's value, not a count or a sum (API §4.2:
// the catalogue decides between a size and a count). «шампунь гліс на 400», «крем нівея 150» are the 400 ml and 150 ml variants, not 400 and 150 pieces;
// «гель для душу лаванда 250» and «п'ять шампунів гліс по 400» are no receipt total and no discount.

// The words that may stand between a line and a size said after it.
const SIZE_LEADS: ReadonlySet<string> = new Set(["на", "по"]);
// A count this small said right after the product with no «на» / «по» stays a count («торт медовий 2», «лак есі 5»): a size needs the preposition then.
// D75: a fraction is no count of pieces, so a variant that holds it is the size at any value («кола 0,5» is the 0,5 л bottle); a product sold by the kilo
// with no such variant keeps it its quantity («сир гауда 0,5»).
const SMALLEST_BARE_SIZE = 10;
// «поменяй количество лабретов на шесть»: the number is a count when the words say so.
const COUNT_NOUNS: ReadonlySet<string> = new Set(["кількість", "кількості", "количество", "количества", "штук", "штуки", "штука", "штуку"]);
// Money params a bare number may have been read into, besides the order lines (`money` and the discount union).
const MONEY_TYPES: ReadonlySet<string> = new Set(["money", "discount", "price", "amount"]);

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Digits or number words only: «400», «чотириста», «сто двадцять».
function bareNumber(text: string): boolean {
  const words = wordsOf(text);
  return words.length > 0 && words.every((word) => numberWordKind(word) !== null);
}

function numberOf(text: string): number | null {
  const words = wordsOf(text);
  if (words.length !== 1) return null;
  const value = Number((words[0] ?? "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

// An attr that says a number («два кило», «десятий», «три секції»): a line that has one keeps a bare number after it as its count («… один літр два»).
function numeric(attr: string): boolean {
  return wordsOf(attr).some((word) => numberWordKind(word) !== null || ordinalValue(word) !== null);
}

function productAt(words: readonly string[], line: OrderLine): number {
  const product = wordsOf(line.product);
  return words.findIndex((_, start) => product.length > 0 && product.every((word, offset) => words[start + offset] === word));
}

// Where a line's words end in the utterance: its product said, then the attrs said right after it (in any order); -1 when the product is not found.
function lineEnd(words: readonly string[], line: OrderLine): number {
  const product = wordsOf(line.product);
  const at = productAt(words, line);
  if (at < 0) return -1;
  let end = at + product.length;
  const attrs = line.attrs.map(wordsOf);
  for (let found = true; found; ) {
    found = false;
    for (const attr of attrs) {
      if (attr.length && attr.every((word, offset) => words[end + offset] === word)) {
        end += attr.length;
        found = true;
      }
    }
  }
  return end;
}

// The size said at `from`: the number's words after an optional «на» / «по», and whether the preposition was said.
function sizeAt(words: readonly string[], from: number, said: string): boolean | null {
  const number = wordsOf(said);
  const lead = SIZE_LEADS.has(words[from] ?? "") ? 1 : 0;
  return number.every((word, offset) => words[from + lead + offset] === word) ? lead === 1 : null;
}

// Does one of the product's variants hold the number?
function variantHolds(line: OrderLine, number: string, context: CompiledContext): boolean {
  const lookup = { records: context.records, customers: context.customers, restoring: false };
  const found = productRef(line.product, lookup);
  const [index] = found.indices;
  if (found.ref.status !== "resolved" || index === undefined) return false;
  const values = context.records.valuesOf(index);
  return values !== null && values !== undefined && values.matching(number).length > 0 && !line.attrs.some((attr) => values.matching(attr).length > 0 && bareNumber(attr));
}

function heldAfter(words: readonly string[], line: OrderLine, number: string, context: CompiledContext): boolean {
  if (!bareNumber(number) || line.attrs.some(numeric) || words.some((word) => COUNT_NOUNS.has(word))) return false;
  // A count said before the product is the count («десять покришок … на десять дюймів»).
  const said = wordsOf(number);
  const start = productAt(words, line);
  if (words.slice(0, Math.max(0, start)).some((_, from) => said.every((word, offset) => words[from + offset] === word))) return false;
  const end = lineEnd(words, line);
  const lead = end < 0 ? null : sizeAt(words, end, number);
  if (lead === null) return false;
  const value = numberOf(number);
  return (lead || value === null || value >= SMALLEST_BARE_SIZE || !Number.isInteger(value)) && variantHolds(line, number, context);
}

// A line's own count said after it as a bare number the variants hold becomes its attr; the line then counts one.
function sized(lines: readonly OrderLine[], words: readonly string[], context: CompiledContext): OrderLine[] {
  return lines.map((line) => {
    const quantity = line.quantity;
    if (quantity === undefined || line.said.length !== 1 || line.said[0] !== quantity || !heldAfter(words, line, quantity, context)) return line;
    return { product: line.product, attrs: [...line.attrs, quantity], said: [], ...(line.asks === undefined ? {} : { asks: line.asks }) };
  });
}

export function variantNumbers(intent: Intent, params: Params, utterance: string, context: CompiledContext): Params {
  const words = wordsOf(utterance);
  const out: Record<string, ParamValue> = { ...params };
  const lineParams = Object.entries(intent.params).filter(([name, type]) => type === ORDER_LINES && isLines(out[name]));
  for (const [name] of lineParams) {
    const lines = out[name];
    if (isLines(lines)) out[name] = sized(lines, words, context);
  }
  // A money span no cue word placed right after a line whose product's variants hold it: the line's attr.
  for (const [name, type] of Object.entries(intent.params)) {
    const said = out[name];
    if (!MONEY_TYPES.has(type) || typeof said !== "string") continue;
    for (const [linesName] of lineParams) {
      const lines = out[linesName];
      if (!isLines(lines)) continue;
      const at = lines.findIndex((line) => heldAfter(words, line, said, context));
      const line = lines[at];
      if (line === undefined) continue;
      out[linesName] = lines.map((other, index) => (index === at ? { ...line, attrs: [...line.attrs, said] } : other));
      delete out[name];
      break;
    }
  }
  return out;
}
