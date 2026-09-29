import { CASE_ENDINGS, CYRILLIC_LATIN, HOMOGLYPHS, SOUND_READINGS, type SoundRule } from "./lexicon/names.ts";

// How a word sounds, for comparing a brand said in Cyrillic with its Latin spelling (D64, D66).

const LATIN = /^[a-z']+$/;
const VOWEL_LETTERS = /[aeiouy]/;
export const SHORTEST_SOUNDED = 3;

// A token's letters written in Latin (`CYRILLIC_LATIN`); Latin letters stay.
export function latinLetters(token: string): string {
  return Array.from(token, (letter) => CYRILLIC_LATIN.get(letter) ?? letter).join("");
}

// A Cyrillic token written with the Latin letters it looks like: «ст» «ct», «с» «c» (a model code typed or heard in Cyrillic, «ст-с200» for CT-S200).
export function homoglyphs(token: string): string {
  return Array.from(token, (letter) => HOMOGLYPHS.get(letter) ?? letter).join("");
}

// A Latin token with no vowel letter is a code («ct», «rtx», «xl»): it is said letter by letter, never by its sounds.
export function isCode(token: string): boolean {
  return LATIN.test(token) && !VOWEL_LETTERS.test(token);
}

function applied(letters: string, rules: readonly SoundRule[]): string {
  return rules.reduce((text, [pattern, by]) => text.replace(pattern, by), letters);
}

// A word's sounds in Latin letters, after an English-like reading of a Latin spelling: «ph» f, «c» s before e/i/y and k elsewhere, «x» ks, «w» v before a
// vowel, a silent final «e» dropped; «h» and «g» are one sound, «s» and «z» are one; every run of vowels is one «V», whatever the vowels (a brand's English
// vowels are not its Ukrainian ones). «найк» and «nike» are «nVk», «айфон» and «iphone» «VfVn», «керастаз» and «kerastase» «kVrVstVs»; «сукня» «sVknV» is no
// «skinny» «skVnV». `reading` rewrites a Latin spelling first as another language reads it (`SOUND_READINGS`).
function readSounds(token: string, reading: readonly SoundRule[] = []): string {
  const word = token.toLowerCase();
  const letters = applied(latinLetters(word).replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1"), reading);
  const read = letters
    .replace(/(ts)+/g, "ts")
    .replace(/sch/g, "S")
    .replace(/t?ch/g, "C")
    .replace(/sh/g, "S")
    .replace(/zh/g, "Z")
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ck/g, "k")
    .replace(/igh/g, "i")
    .replace(/qu/g, "kv")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/j/g, "dZ")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/w(?=[aeiouy])/g, "v")
    .replace(/w/g, "")
    .replace(/h/g, "g")
    .replace(/z/g, "s");
  const said = LATIN.test(word) && word.length > SHORTEST_SOUNDED && /[^aeiouy]e$/.test(word) ? read.replace(/e$/, "") : read;
  return said
    .replace(/[aeiouy]+/g, "V")
    .replace(/(.)\1+/g, "$1");
}

// Sound keys already read: a catalogue's Latin tokens are compared with every Cyrillic word said, so each key is read once (§2.4 of
// docs/design/sho-api-v2.md); the memo is dropped whole when it grows past its size.
const SOUND_KEYS = new Map<string, string>();
const SOUND_KEYS_KEPT = 100_000;

export function soundKey(token: string): string {
  const known = SOUND_KEYS.get(token);
  if (known !== undefined) return known;
  if (SOUND_KEYS.size >= SOUND_KEYS_KEPT) SOUND_KEYS.clear();
  const key = readSounds(token);
  SOUND_KEYS.set(token, key);
  return key;
}

const READ_KEYS = new Map<string, readonly string[]>();

// The spoken forms a Latin word may take, as sound keys (D66): the English-like reading (`soundKey`) and the readings of `SOUND_READINGS` («Lavazza»
// «лавацца», «Ceresit» «церезит», «Logitech» «логітек», «Heinz» «хайнц», «Power» «пауер», «Roche» «рош»). A brand the shop added with no spoken form is said
// in one of them; the keys are read once, when the context is compiled.
export function soundKeys(token: string): readonly string[] {
  const known = READ_KEYS.get(token);
  if (known !== undefined) return known;
  if (READ_KEYS.size >= SOUND_KEYS_KEPT) READ_KEYS.clear();
  const applies = (reading: readonly SoundRule[]) => reading.some(([pattern]) => token.search(pattern) >= 0);
  const keys = LATIN.test(token) ? [...new Set([soundKey(token), ...SOUND_READINGS.filter(applies).map((reading) => readSounds(token, reading))])] : [soundKey(token)];
  READ_KEYS.set(token, keys);
  return keys;
}

// How many consonant sounds a key says.
export function sounds(key: string): number {
  return key.replace(/V/g, "").length;
}

// A Cyrillic word and the stems left after a case ending (at least three letters), which `soundMatch` compares by sound («айфонів» → «айфон»).
export function soundStems(said: string): string[] {
  // D73: «э» and «ё» are «е» before a case ending comes off («серавэ» CeraVe as «серавє»).
  const spoken = said.replace(/[эё]/g, "е");
  return [spoken, ...CASE_ENDINGS.filter((ending) => spoken.endsWith(ending) && spoken.length - ending.length >= SHORTEST_SOUNDED).map((ending) => spoken.slice(0, -ending.length))];
}

// A short Latin word (two letters with a vowel: «la», «jo») said in Cyrillic («ля», «джо»): by its sound key, the Cyrillic word as it is.
function shortWord(cyrillic: string, latin: string): boolean {
  return latin.length === 2 && !isCode(latin) && soundKey(cyrillic) === soundKey(latin);
}

// A Cyrillic spelling of Latin letters, letter by letter: each Cyrillic letter is the Latin one it is written as («р» r) or looks like («с» c, «х» x).
export function lettersAlike(cyrillic: string, latin: string): boolean {
  if (latinLetters(cyrillic) === latin) return true;
  const said = Array.from(cyrillic);
  return said.length === latin.length && said.every((letter, index) => latin[index] === CYRILLIC_LATIN.get(letter) || latin[index] === HOMOGLYPHS.get(letter));
}

// A Cyrillic word said for a Latin one: a code or a short word letter by letter, in the letters it is written with or looks like («с24», «ст» CT, «м»); a
// word of three letters or more by one of its sound keys, maybe after a case ending («айфонів», «айфона»); «XL» is said «ікс ель» (`spelledSize`).
export function soundsLike(cyrillic: string, latin: string): boolean {
  if (latin.length < SHORTEST_SOUNDED || isCode(latin)) return lettersAlike(cyrillic, latin) || shortWord(cyrillic, latin);
  const keys = soundKeys(latin).filter((key) => sounds(key) > 0);
  return keys.length > 0 && soundStems(cyrillic).some((stem) => keys.includes(soundKey(stem)));
}
