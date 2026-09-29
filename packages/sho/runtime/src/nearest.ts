import type { ShopProduct, ShopRecord } from "./context.ts";
import { UNITS, UNIT_KEYS } from "./lexicon/units.ts";
import { PART_STOPS, isCyrillic, isLatin, isNumber, nameTokens, spelled, tokenMatch, type Written } from "./names.ts";
import { fullNames } from "./records.ts";
import type { Candidate, NearCandidate } from "./result.ts";
import { latinLetters, soundKey } from "./sounds.ts";

// D78: the records nearest to a name the context does not know (`status: "unknown"`), for the card to offer before «create»: the words said against the
// words of each record's names and aliases, a word by the matcher's own rule (`tokenMatch`: word forms, uk / ru spellings, the other script by sound) or,
// when that fails, by its letters (the edit distance of the two words spelled alike in Latin letters: «каппучіно» «капучино», «мельнік» «мельник»), and
// the record by how much of both sides the matched words cover (a Dice score). Only records that reach `NEAREST_FLOOR` are offered, at most
// `MOST_NEAREST`, best first.

export const MOST_NEAREST = 3;
// The least score a record is offered at: one word of two said and one of two written that match is 0.5 («торт наполеон» for «Торт медовий», «олегу
// петренку» for «Олег Петров»), not enough; one word misheard by a letter or two is about 0.8.
export const NEAREST_FLOOR = 0.6;
// A word counts as said for a written one from this letter similarity on (1 − distance / length), or when the matcher matches them.
const WORD_FLOOR = 0.7;
// Below this letter similarity the matcher is not asked of two words of one script (it matches only words that start alike, which their letters show).
const ASK_MATCHER = 0.4;
const SHORTEST = 3;

function spelledLatin(word: string): string[] {
  return Array.from(latinLetters(spelled(word, true)));
}

function distance(a: readonly string[], b: readonly string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length] ?? Math.max(a.length, b.length);
}

// How well a word said stands for a written one, 0 to 1, with both words' letters spelled alike in Latin (`spelledLatin`) given.
function similarity(said: string, saidLetters: readonly string[], known: string, knownLetters: readonly string[], written: Written): number {
  if (said === known) return 1;
  if (isNumber(said) || isNumber(known)) return 0;
  const prefix = said.slice(0, SHORTEST) === known.slice(0, SHORTEST);
  // A word said in the other script is matched by its sound («найк» Nike), which its letters do not show: asked when the two start with one sound.
  const crossed = ((isCyrillic(said) && isLatin(known)) || (isLatin(said) && isCyrillic(known))) && soundKey(said).charAt(0) === soundKey(known).charAt(0);
  const longest = Math.max(saidLetters.length, knownLetters.length);
  const short = saidLetters.length < SHORTEST || knownLetters.length < SHORTEST;
  // The letters can say no more than the lengths allow: most words of a catalogue are passed over here.
  const bound = short ? 0 : 1 - Math.abs(saidLetters.length - knownLetters.length) / longest;
  if (!prefix && !crossed && bound < ASK_MATCHER) return 0;
  const letters = short || bound < ASK_MATCHER ? 0 : 1 - distance(saidLetters, knownLetters) / longest;
  if ((letters >= ASK_MATCHER || prefix || crossed) && tokenMatch(said, known, written) !== null) return 1;
  return letters;
}

export function wordSimilarity(said: string, known: string, written: Written = {}): number {
  return similarity(said, spelledLatin(said), known, spelledLatin(known), written);
}

// The words of a name that say what the record is: stop words, numbers and units left out unless the words said have them too.
function significant(tokens: readonly string[], numbers: boolean): string[] {
  return tokens.filter((token) => !PART_STOPS.has(token) && (numbers || (!isNumber(token) && !UNITS.has(token) && !UNIT_KEYS.has(token))));
}

interface Owner {
  readonly candidate: Candidate;
  readonly forms: readonly (readonly string[])[];
}

// Every word of a list's names, with the records that have it: the words said are compared with each word once.
export class NearIndex {
  private readonly owners: readonly Owner[];
  private readonly written: Written;
  private readonly words = new Map<string, number[]>();
  private readonly letters = new Map<string, readonly string[]>();
  private readonly memo = new Map<string, ReadonlyMap<string, number>>();

  constructor(owners: readonly Owner[], written: Written = {}) {
    this.owners = owners;
    this.written = written;
    for (const [index, owner] of owners.entries()) {
      for (const form of owner.forms) {
        for (const token of form) {
          const known = this.words.get(token);
          if (known === undefined) {
            this.words.set(token, [index]);
            this.letters.set(token, spelledLatin(token));
          }
          else if (known.at(-1) !== index) known.push(index);
        }
      }
    }
  }

  // The written words a word said stands for, with how well.
  private matched(said: string): ReadonlyMap<string, number> {
    const known = this.memo.get(said);
    if (known !== undefined) return known;
    const found = new Map<string, number>();
    const letters = spelledLatin(said);
    for (const [word, known] of this.letters) {
      const score = similarity(said, letters, word, known, this.written);
      if (score >= WORD_FLOOR) found.set(word, score);
    }
    this.memo.set(said, found);
    return found;
  }

  nearest(text: string, most: number = MOST_NEAREST): NearCandidate[] {
    const said = nameTokens(text);
    const numbers = said.some(isNumber);
    const words = significant(said, numbers);
    if (!words.length) return [];
    const matches = words.map((word) => this.matched(word));
    const reached = new Set<number>();
    for (const found of matches) for (const word of found.keys()) for (const owner of this.words.get(word) ?? []) reached.add(owner);
    const scored: [number, number][] = [];
    for (const index of reached) {
      const owner = this.owners[index];
      if (owner === undefined) continue;
      let best = 0;
      for (const form of owner.forms) {
        const own = significant(form, numbers);
        if (!own.length) continue;
        const sum = matches.reduce((total, found) => total + Math.max(0, ...own.map((word) => found.get(word) ?? 0)), 0);
        best = Math.max(best, (2 * sum) / (words.length + own.length));
      }
      if (best >= NEAREST_FLOOR) scored.push([index, best]);
    }
    scored.sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    return scored.slice(0, most).flatMap(([index, score]) => {
      const owner = this.owners[index];
      return owner === undefined ? [] : [{ ...owner.candidate, score: Math.round(score * 100) / 100 }];
    });
  }
}

export function productIndex(products: readonly ShopProduct[]): NearIndex {
  return new NearIndex(products.map((product) => ({ candidate: { id: product.id, name: product.name }, forms: [...fullNames(product), ...product.aliases].map(nameTokens) })));
}

export function recordIndex(records: readonly ShopRecord[]): NearIndex {
  return new NearIndex(records.map((record) => ({ candidate: { id: record.id, name: record.name }, forms: [record.name, ...record.aliases].map(nameTokens) })), { proper: true });
}

// The variants of one product by their values together, each value and each alias: an attr the product's variants do not have against each.
export function variantIndex(product: ShopProduct): NearIndex {
  return new NearIndex((product.variants ?? []).map((variant) => ({
    candidate: { id: variant.id, name: variant.name, productId: product.id, ...(variant.label === null ? {} : { label: variant.label }) },
    forms: [variant.values.join(" "), ...variant.values, ...variant.aliases].map(nameTokens),
  })));
}
