import { COMMAND_CONNECTORS } from "./lexicon/segment.ts";
import type { Logits } from "./decode.ts";
import type { Offset } from "./tokenizer.ts";

export const MAX_COMMANDS = 3;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function startsCommand(pair: Logits | undefined): boolean {
  if (pair === undefined) return false;
  const stays = pair[0];
  const starts = pair[1];
  return stays !== undefined && starts !== undefined && starts > stays;
}

export function segmentStarts(utterance: string, offsets: readonly Offset[], logits: readonly Logits[]): number[] {
  const starts = [0];
  offsets.forEach(([left, right], index) => {
    if (left >= right || left === 0 || utterance[left - 1] !== " ") return;
    if (startsCommand(logits[index]) && !starts.includes(left)) starts.push(left);
  });
  return starts;
}

// D85 (F3 of the dictation v5 report): a word as compared for a restart, case and punctuation aside.
function plainWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// D85: «найди контрагента найди контрагента где есть слово ранок»: the speaker started over, and the piece before says only the start of the piece
// after it (its words, compared plain, are a proper prefix of the next piece's, with no connector between them: «п'ять штук і п'ять штук пирогів» says
// it twice on purpose): it is no command of its own.
function restarted(words: readonly string[], next: readonly string[] | undefined, joined: boolean): boolean {
  return !joined && next !== undefined && words.length > 0 && words.length < next.length && words.every((word, index) => plainWord(word) === plainWord(next[index] ?? ""));
}

export function splitCommands(utterance: string, starts: readonly number[]): string[] {
  if (starts.length < 2) return [utterance];
  const ends = [...starts.slice(1), utterance.length];
  const pieces = starts.map((start, index) => wordsOf(utterance.slice(start, ends[index])));
  // Whether a connector joined each piece to the next (at the end of the one or the start of the other).
  const joined = pieces.map((words, index) => COMMAND_CONNECTORS.has(words.at(-1) ?? "") || COMMAND_CONNECTORS.has(pieces[index + 1]?.[0] ?? ""));
  pieces.forEach((words, index) => {
    while (index < pieces.length - 1 && words.length && COMMAND_CONNECTORS.has(words.at(-1) ?? "")) words.pop();
    while (index > 0 && words.length && COMMAND_CONNECTORS.has(words[0] ?? "")) words.shift();
  });
  const texts = pieces.filter((words, index) => words.length && !restarted(words, pieces[index + 1], joined[index] ?? false)).map((words) => words.join(" "));
  return texts.length > 1 ? texts : [utterance];
}
