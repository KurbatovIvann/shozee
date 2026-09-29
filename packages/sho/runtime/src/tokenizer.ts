import { BundleError } from "./errors.ts";

const SPACE = "▁";

export interface TokenizerSpec {
  readonly vocab: ReadonlyMap<string, number>;
  readonly merges: readonly (readonly [left: string, right: string])[];
  readonly unkToken: string;
  readonly byteFallback: boolean;
  readonly fuseUnk: boolean;
}

export interface TokenizerLimits {
  readonly maxLength: number;
  readonly bosId: number;
  readonly eosId: number;
}

export type Offset = readonly [start: number, end: number];

export interface Encoding {
  readonly ids: readonly number[];
  readonly offsets: readonly Offset[];
}

interface Item {
  readonly char: string;
  readonly at: number;
  readonly end: number;
}

interface BpeSymbol {
  readonly text: string;
  readonly positions: readonly number[];
  readonly atomic: boolean;
  readonly unknown: boolean;
}

interface Encoded {
  readonly id: number;
  readonly positions: readonly number[];
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, name) : undefined;
}

function mergePair(pair: unknown, rank: number): readonly [string, string] {
  if (Array.isArray(pair)) {
    const [left, right]: unknown[] = pair;
    if (typeof left === "string" && typeof right === "string") return [left, right];
  } else if (typeof pair === "string") {
    const [left, right] = pair.split(" ");
    if (left !== undefined && right !== undefined) return [left, right];
  }
  throw new BundleError("tokenizer_merge", `merge ${rank} is not a pair of strings`);
}

export function parseTokenizerSpec(json: unknown): TokenizerSpec {
  const model = field(json, "model");
  const vocabJson = field(model, "vocab");
  if (typeof vocabJson !== "object" || vocabJson === null || Array.isArray(vocabJson)) throw new BundleError("tokenizer_vocab", "tokenizer.json model.vocab is not an object");
  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(vocabJson)) {
    if (typeof id !== "number" || !Number.isInteger(id)) throw new BundleError("tokenizer_vocab", `vocab entry ${JSON.stringify(token)} has no integer id`);
    vocab.set(token, id);
  }
  const mergesJson = field(model, "merges");
  if (!Array.isArray(mergesJson)) throw new BundleError("tokenizer_merges", "tokenizer.json model.merges is not an array");
  const merges = mergesJson.map((pair: unknown, rank) => mergePair(pair, rank));
  const unkToken = field(model, "unk_token");
  if (typeof unkToken !== "string" || !vocab.has(unkToken)) throw new BundleError("tokenizer_unk", "tokenizer.json model.unk_token is not a vocabulary token");
  const byteFallback = field(model, "byte_fallback");
  if (typeof byteFallback !== "boolean") throw new BundleError("tokenizer_byte_fallback", "tokenizer.json model.byte_fallback is not a boolean");
  const fuseUnk = field(model, "fuse_unk") ?? false;
  if (typeof fuseUnk !== "boolean") throw new BundleError("tokenizer_fuse_unk", "tokenizer.json model.fuse_unk is not a boolean");
  return { vocab, merges, unkToken, byteFallback, fuseUnk };
}

export function utf8Bytes(char: string): number[] {
  const point = char.codePointAt(0) ?? 0;
  if (point < 0x80) return [point];
  if (point < 0x800) return [0xc0 | (point >> 6), 0x80 | (point & 0x3f)];
  if (point >= 0xd800 && point <= 0xdfff) return [0xef, 0xbf, 0xbd];
  if (point < 0x10000) return [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)];
  return [0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)];
}

function firstCharLength(text: string): number {
  const point = text.codePointAt(0);
  return point === undefined ? 0 : String.fromCodePoint(point).length;
}

export class Tokenizer {
  private readonly vocab: ReadonlyMap<string, number>;
  private readonly ranks = new Map<string, Map<string, number>>();
  private readonly unk: number;
  private readonly byteFallback: boolean;
  private readonly fuseUnk: boolean;
  private readonly maxLength: number;
  private readonly bos: number;
  private readonly eos: number;
  private readonly cache = new Map<string, readonly Encoded[]>();

  constructor(spec: TokenizerSpec, limits: TokenizerLimits) {
    this.vocab = spec.vocab;
    spec.merges.forEach(([left, right], rank) => {
      if (!this.vocab.has(left + right)) return;
      let row = this.ranks.get(left);
      if (row === undefined) {
        row = new Map();
        this.ranks.set(left, row);
      }
      if (!row.has(right)) row.set(right, rank);
    });
    this.unk = spec.vocab.get(spec.unkToken) ?? 0;
    this.byteFallback = spec.byteFallback;
    this.fuseUnk = spec.fuseUnk;
    this.maxLength = limits.maxLength;
    this.bos = limits.bosId;
    this.eos = limits.eosId;
  }

  private pieces(text: string): Item[][] {
    const chars: Item[] = [];
    if (text && !text.startsWith(" ") && !text.startsWith(SPACE)) chars.push({ char: SPACE, at: 0, end: firstCharLength(text) });
    for (let index = 0; index < text.length; ) {
      const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
      chars.push({ char: char === " " ? SPACE : char, at: index, end: index + char.length });
      index += char.length;
    }
    const pieces: Item[][] = [];
    let current: Item[] | undefined;
    for (const item of chars) {
      if (item.char === SPACE || current === undefined) {
        current = [];
        pieces.push(current);
      }
      current.push(item);
    }
    return pieces;
  }

  private symbolsOf(piece: readonly Item[]): BpeSymbol[] {
    const symbols: BpeSymbol[] = [];
    piece.forEach((item, position) => {
      if (this.vocab.has(item.char)) {
        symbols.push({ text: item.char, positions: [position], atomic: false, unknown: false });
        return;
      }
      const names = utf8Bytes(item.char).map((byte) => `<0x${byte.toString(16).toUpperCase().padStart(2, "0")}>`);
      if (this.byteFallback && names.every((name) => this.vocab.has(name))) {
        for (const name of names) symbols.push({ text: name, positions: [position], atomic: true, unknown: false });
      } else {
        const previous = symbols[symbols.length - 1];
        if (this.fuseUnk && previous?.unknown) symbols[symbols.length - 1] = { ...previous, positions: [...previous.positions, position] };
        else symbols.push({ text: item.char, positions: [position], atomic: false, unknown: true });
      }
    });
    return symbols;
  }

  private merge(symbols: BpeSymbol[]): BpeSymbol[] {
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let index = 0; index + 1 < symbols.length; index++) {
        const left = symbols[index];
        const right = symbols[index + 1];
        if (left === undefined || right === undefined) continue;
        if (left.atomic || right.atomic || left.unknown || right.unknown) continue;
        const rank = this.ranks.get(left.text)?.get(right.text);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = index;
        }
      }
      const left = symbols[best];
      const right = symbols[best + 1];
      if (best < 0 || left === undefined || right === undefined) return symbols;
      symbols.splice(best, 2, { text: left.text + right.text, positions: left.positions.concat(right.positions), atomic: false, unknown: false });
    }
  }

  private encodePiece(piece: readonly Item[]): { readonly id: number; readonly items: readonly Item[] }[] {
    const key = piece.map((item) => item.char).join("");
    let merged = this.cache.get(key);
    if (merged === undefined) {
      merged = this.merge(this.symbolsOf(piece)).map((symbol) => ({ id: symbol.unknown ? this.unk : (this.vocab.get(symbol.text) ?? this.unk), positions: symbol.positions }));
      this.cache.set(key, merged);
    }
    return merged.map((symbol) => ({ id: symbol.id, items: symbol.positions.flatMap((position) => piece[position] ?? []) }));
  }

  encode(text: string): Encoding {
    const tokens: { readonly id: number; readonly items: readonly Item[] }[] = [];
    for (const piece of this.pieces(text)) tokens.push(...this.encodePiece(piece));
    const content = tokens.slice(0, this.maxLength - 2);
    const ids = [this.bos, ...content.map((token) => token.id), this.eos];
    const offsets: Offset[] = [[0, 0], ...content.map((token) => this.offsetOf(text, token.items)), [0, 0]];
    return { ids, offsets };
  }

  private offsetOf(text: string, items: readonly Item[]): Offset {
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return [0, 0];
    let start = first.at;
    const end = last.end;
    while (start < end && /\s/.test(text.charAt(start))) start++;
    return [start, end];
  }
}
