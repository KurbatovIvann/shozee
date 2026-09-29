import { ADJECTIVE_TAILS, ATTR_ENDINGS, COLOUR_STEMS, LATIN_COLOURS, SIZE_STEMS } from "./lexicon/attrs.ts";
import { SIZE_LETTERS } from "./lexicon/names.ts";
import { UNITS, UNIT_KEYS } from "./lexicon/units.ts";
import { numberWordKind, ordinalValue } from "./numbers.ts";

// D78: what an attr span says, so that two attrs the model tagged apart and said side by side («білу m», «чорних 42-й», «шоколадний великий») stay two
// attrs of the line, while one attr the model tagged in pieces («чорний титан», «темно синій», «slim fit», «256 гб», «сорок шостий») stays one.
// size: a number, an ordinal, a number with its unit, a letter size, a size word; unit: unit words alone (they go with the number before them); colour: a
// colour word; adjective: another adjective; word: anything else.
export type AttrKind = "size" | "unit" | "colour" | "adjective" | "word";

const DIGITS = /^[0-9]+(?:[.,][0-9]+)?(?:-?\p{L}{1,3})?$/u;
// D82: «60 на 60», «20 x 30 см»: a size of two or three numbers with a word between them.
const DIMENSION_JOINERS: ReadonlySet<string> = new Set(["на", "x", "х", "×"]);
const LETTER_SIZE = /^(?:[0-9]?x{0,3}[sl]|m|x{1,3}l)$/;
const SHORTEST_ADJECTIVE = 5;

function stemmed(word: string, stems: readonly string[]): boolean {
  return stems.some((stem) => word.startsWith(stem) && ATTR_ENDINGS.has(word.slice(stem.length)));
}

function numeric(word: string): boolean {
  return DIGITS.test(word) || numberWordKind(word) !== null || ordinalValue(word) !== null;
}

function unitWord(word: string): boolean {
  return UNITS.has(word) || UNIT_KEYS.has(word);
}

function letterSize(word: string): boolean {
  return LETTER_SIZE.test(word) || SIZE_LETTERS.has(word);
}

// «60 на 60 см»: numbers with a joiner between each two, a unit after any of them; never a joiner at the start or the end, nor two in a row.
function dimensions(words: readonly string[]): boolean {
  const joiners = words.filter((word) => DIMENSION_JOINERS.has(word)).length;
  if (!joiners || DIMENSION_JOINERS.has(words.at(-1) ?? "")) return false;
  return words.every((word, index) => numeric(word) || unitWord(word) || (DIMENSION_JOINERS.has(word) && numeric(words[index + 1] ?? "")));
}

export function attrKind(text: string): AttrKind {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const [first] = words;
  if (first === undefined) return "word";
  if (numeric(first) && words.every((word) => numeric(word) || unitWord(word))) return "size";
  if (numeric(first) && dimensions(words)) return "size";
  if (words.every(letterSize)) return "size";
  if (words.every(unitWord)) return "unit";
  if (words.length !== 1) return "word";
  if (LATIN_COLOURS.has(first) || stemmed(first, COLOUR_STEMS)) return "colour";
  if (stemmed(first, SIZE_STEMS)) return "size";
  return Array.from(first).length >= SHORTEST_ADJECTIVE && ADJECTIVE_TAILS.some((tail) => first.endsWith(tail)) ? "adjective" : "word";
}

// Whether the attr span said right after another is an attr of its own rather than the rest of it: a size next to a colour or an adjective, or a colour
// next to another adjective. Unit words after a number, two numbers, two colours, two adjectives and any other word join as before (D65). D82: unit words
// after a colour or an adjective are an attr of their own («апельсиновий | літр»): a unit goes with a number only.
export function attrApart(before: string, after: string): boolean {
  const left = attrKind(before);
  const right = attrKind(after);
  const described = (kind: AttrKind) => kind === "colour" || kind === "adjective";
  if (right === "unit") return described(left);
  if (left === right || left === "word" || right === "word") return false;
  if (left === "size" || right === "size") return described(left) || described(right);
  return described(left) && described(right);
}

// D82: «бежевий м», «256 гб чорний», «апельсиновий літр»: one attr span the model tagged whole that says two attrs of the kinds `attrApart` keeps
// apart, cut where they meet; the first such cut. Null when no cut gives two such attrs («чорний титан», «сорок шостий», «темно синій», «256 гб»).
export function attrCut(text: string): readonly [before: string, after: string] | null {
  const words = text.split(" ").filter(Boolean);
  for (let at = 1; at < words.length; at++) {
    const before = words.slice(0, at).join(" ");
    const after = words.slice(at).join(" ");
    if (attrApart(before, after)) return [before, after];
  }
  return null;
}
