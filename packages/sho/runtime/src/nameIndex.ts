import { NAME_ENDINGS, NAME_FOLDS } from "./lexicon/customers.ts";
import { ASR_SLIPS, CYRILLIC_LATIN, HOMOGLYPHS, LETTER_NAMES } from "./lexicon/names.ts";
import { measureAt, measureKey } from "./measures.ts";
import { formKeys } from "./morphology.ts";
import { PREPOSITION_FORMS, crossForms, exonymPartners, isCyrillic, isLatin, latinLetters, soundKey, soundKeys, soundStems, spelledSize, withoutApostrophes, SHORTEST_SOUNDED } from "./names.ts";
import { lettersOnly } from "./words.ts";

// Token postings over catalogue names (docs/design/sho-api-v2.md §2.4): every name is looked at only when each word said can match one of its tokens, so a
// lookup runs `nameFit` on a handful of names instead of the whole catalogue. A key is a necessary condition of `tokenMatch`: the same token, the first
// three letters without apostrophes (`wordMatch` needs a common start of three), the word's paradigm stems (`morphology.ts`, D66: «ніж» and «ножів» start
// otherwise), a Latin token's sound keys (said in Cyrillic, `soundsLike`), a code's or short token's letters, a listed exonym, a word the recogniser writes
// for another (`ASR_SLIPS`); a number and its unit by the measure they say («500 g» and «0.5 kg», D66); a letter size said by letter names («ікс ел») finds
// the size it spells. An alias's Cyrillic words are posted by sound too: a Latin word said for them is compared by sound (D66). The candidates are a
// superset of the names that fit; the caller still runs `nameFit` on them.

const PREFIX = 3;
// Cyrillic words up to this long are also posted under every letter-by-letter Latin spelling (`sounds.ts` `lettersAlike`): «ртх» RTX.
const LONGEST_SPELLED = 4;

function prefixOf(token: string): string | null {
  const word = withoutApostrophes(token);
  return lettersOnly(word) && word.length >= PREFIX ? word.slice(0, PREFIX) : null;
}

const FOLDING = /[іїыєэ]/;

// The prefixes a word is posted and looked up by: its own, and folded as names are (`NAME_FOLDS`: «інгул» and «ингул» start alike, D66).
function prefixKeys(token: string): string[] {
  const prefix = prefixOf(token);
  if (prefix === null) return [];
  if (!FOLDING.test(prefix)) return [`<${prefix}`];
  const folded = Array.from(prefix, (letter) => NAME_FOLDS.get(letter) ?? letter).join("");
  return [`<${prefix}`, `<${folded}`];
}

// Every Latin spelling of a short Cyrillic word, letter by letter as written or as it looks.
function spellings(token: string): string[] {
  const letters = Array.from(token);
  if (letters.length > LONGEST_SPELLED) return [];
  let found = [""];
  for (const letter of letters) {
    const options = [...new Set([CYRILLIC_LATIN.get(letter), HOMOGLYPHS.get(letter)].filter((option): option is string => option !== undefined))];
    if (!options.length) return [];
    found = found.flatMap((start) => options.map((option) => `${start}${option}`));
  }
  return found;
}

function wordKeys(token: string, alias: boolean): string[] {
  const keys = [`=${token}`, ...formKeys(token).map((key) => `%${key}`), ...prefixKeys(token)];
  if (isLatin(token) && token.length >= SHORTEST_SOUNDED - 1) keys.push(...soundKeys(token).map((key) => `~${key}`));
  if (alias && isCyrillic(token)) keys.push(...soundStems(token).map((stem) => `~${soundKey(stem)}`));
  return keys;
}

// The keys by which a Cyrillic word matches a Latin token: its sound, or a listed exonym.
function soundKeysOf(spoken: string): string[] {
  return [...exonymPartners(spoken).map((partner) => `=${partner}`), ...(isCyrillic(spoken) ? soundStems(spoken).map((stem) => `~${soundKey(stem)}`) : [])];
}

function lookupKeys(spoken: string): string[] {
  const keys = [`=${spoken}`, ...soundKeysOf(spoken), ...formKeys(spoken).map((key) => `%${key}`), ...prefixKeys(spoken)];
  const slip = ASR_SLIPS.get(spoken);
  if (slip !== undefined) keys.push(`=${slip}`);
  // D71: a letter said by name («аш» h), a preposition's other form («у» в), a word with its stem in the other language («черных» чорних).
  for (const letter of LETTER_NAMES.get(spoken) ?? []) keys.push(`=${letter}`);
  for (const forms of PREPOSITION_FORMS) if (forms.has(spoken)) keys.push(...[...forms].map((form) => `=${form}`));
  for (const form of crossForms(spoken)) keys.push(...formKeys(form).map((key) => `%${key}`), ...prefixKeys(form));
  if (isCyrillic(spoken)) keys.push(`=${latinLetters(spoken)}`, ...spellings(spoken).map((spelling) => `=${spelling}`));
  if (isLatin(spoken)) keys.push(...soundKeys(spoken).map((key) => `~${key}`));
  // D72: a two-letter word of a name in a case form («югом», «юга» of «Мебель-Юг»), which no three-letter start finds.
  for (const ending of NAME_ENDINGS) if (spoken.endsWith(ending) && Array.from(spoken).length - Array.from(ending).length === SHORT_STEM) keys.push(`=${spoken.slice(0, -ending.length)}`);
  return keys;
}

const SHORT_STEM = 2;

// Each token's keys, a number and the unit after it also by the measure they say.
function keysOfTokens(tokens: readonly string[], keysOf: (token: string) => string[]): string[][] {
  const keys = tokens.map(keysOf);
  for (let at = 0; at + 1 < tokens.length; at++) {
    const measure = measureAt(tokens, at);
    if (measure === null) continue;
    const key = measureKey(measure);
    keys[at]?.push(key);
    keys[at + 1]?.push(key);
  }
  return keys;
}

function intersect(sorted: readonly number[], other: ReadonlySet<number>): number[] {
  return sorted.filter((index) => other.has(index));
}

const REACH_KEPT = 20_000;

export class NameIndex {
  readonly size: number;
  private readonly postings = new Map<string, number[]>();
  private readonly reach = new Map<string, Set<number>>();

  // `names[i]` are the tokens of name `i` (`nameTokens`); `aliases` the names that are aliases.
  constructor(names: readonly (readonly string[])[], aliases: ReadonlySet<number> = new Set()) {
    this.size = names.length;
    for (const [index, tokens] of names.entries()) {
      const alias = aliases.has(index);
      for (const key of new Set(keysOfTokens(tokens, (token) => wordKeys(token, alias)).flat())) {
        const list = this.postings.get(key);
        if (list === undefined) this.postings.set(key, [index]);
        else list.push(index);
      }
    }
  }

  private matching(keys: readonly string[]): Set<number> {
    const found = new Set<number>();
    for (const key of keys) for (const index of this.postings.get(key) ?? []) found.add(index);
    return found;
  }

  // The names a spoken token's keys reach, read once per token: the segmenter looks up the same words in many runs.
  private reached(spoken: string, extra: readonly string[]): Set<number> {
    let found = this.reach.get(spoken);
    if (found === undefined) {
      if (this.reach.size >= REACH_KEPT) this.reach.clear();
      found = this.matching(lookupKeys(spoken));
      this.reach.set(spoken, found);
    }
    if (!extra.length) return found;
    const more = this.matching(extra);
    for (const index of found) more.add(index);
    return more;
  }

  // The names with a Latin token that a Cyrillic word said matches by its sound or as an exonym («найк» Nike): the only names Cyrillic words can say a
  // part of (`names.ts` `saysEnough`).
  bySound(spoken: readonly string[]): ReadonlySet<number> {
    const found = new Set<number>();
    for (const token of spoken) for (const index of this.matching(soundKeysOf(token))) found.add(index);
    return found;
  }

  // The names in which every spoken token may match some token, in name order: rarest token first. A letter size said by letter names is the size's token.
  candidates(spoken: readonly string[]): number[] {
    if (!spoken.length) return [];
    const size = spelledSize(spoken);
    if (size !== null) return [...new Set([...(this.postings.get(`=${size}`) ?? []), ...this.intersection(spoken)])].sort((left, right) => left - right);
    return this.intersection(spoken);
  }

  // For each spoken token, the names it may match a token of.
  reaching(spoken: readonly string[]): ReadonlySet<number>[] {
    return keysOfTokens(spoken, () => []).map((extra, at) => this.reached(spoken[at] ?? "", extra));
  }

  private intersection(spoken: readonly string[]): number[] {
    const sets = this.reaching(spoken).sort((left, right) => left.size - right.size);
    const [rarest, ...rest] = sets;
    let kept = [...(rarest ?? [])].sort((left, right) => left - right);
    for (const set of rest) {
      if (!kept.length) break;
      kept = intersect(kept, set);
    }
    return kept;
  }
}
