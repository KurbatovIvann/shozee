import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandV2,
  compileContext,
  decode,
  fillReferences,
  parseBundle,
  parseContext,
  parseFocus,
  withCreates,
  withFocus,
  type Bundle,
  type CommandV2,
  type CompiledContext,
  type Decision,
  type Decoded,
  type Heads,
  type Now,
  type Offset,
  type Requirements,
} from "../runtime/src/index.ts";

export interface VectorInput {
  readonly action: string;
  readonly words: readonly (readonly [word: string, tag: string])[];
  readonly enums: Readonly<Record<string, string>>;
  readonly aux: Readonly<Record<string, string>>;
  readonly breaks?: readonly string[];
  readonly lists?: Readonly<Record<string, readonly number[]>>;
}

export interface Vector {
  readonly id: string;
  readonly input: VectorInput | readonly VectorInput[];
  readonly context: string | null;
  readonly requirements?: "catalogue_v3";
  readonly expect: unknown;
}

export interface FocusVector {
  readonly id: string;
  readonly input: VectorInput;
  readonly focus: unknown;
  readonly context: string | null;
  readonly expect: unknown;
}

export const VECTOR_NOW: Now = {
  year: 2026,
  month: 9,
  day: 27,
  hour: 10,
  minute: 0,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new TypeError("not an object of strings");
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== "string") throw new TypeError(`${key} is not text`);
      return [key, item];
    }),
  );
}

function inputOf(value: unknown): VectorInput {
  if (!isRecord(value)) throw new TypeError("a vector input is not an object");
  const { action, words, breaks } = value;
  if (typeof action !== "string") throw new TypeError("input.action");
  if (!Array.isArray(words)) throw new TypeError("input.words");
  const pairs = words.map((pair: unknown): readonly [string, string] => {
    if (
      !Array.isArray(pair) ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    )
      throw new TypeError("input.words holds a non-pair");
    return [pair[0], pair[1]];
  });
  const input = {
    action,
    words: pairs,
    enums: strings(value["enums"]),
    aux: strings(value["aux"]),
  };
  if (breaks === undefined) return input;
  if (
    !Array.isArray(breaks) ||
    !breaks.every((item: unknown) => typeof item === "string")
  )
    throw new TypeError("input.breaks");
  return { ...input, breaks: breaks.map(String) };
}

export function parseVector(value: unknown): Vector {
  if (!isRecord(value)) throw new TypeError("a vector is not an object");
  const { id, input, context, requirements } = value;
  if (typeof id !== "string") throw new TypeError("vector.id");
  if (context !== null && typeof context !== "string")
    throw new TypeError(`${id}: context`);
  if (requirements !== undefined && requirements !== "catalogue_v3")
    throw new TypeError(`${id}: requirements`);
  return {
    id,
    input: Array.isArray(input) ? input.map(inputOf) : inputOf(input),
    context,
    ...(requirements === undefined ? {} : { requirements }),
    expect: value["expect"],
  };
}

export function parseFocusVector(value: unknown): FocusVector {
  if (!isRecord(value)) throw new TypeError("a focus vector is not an object");
  const { id, input, context } = value;
  if (typeof id !== "string") throw new TypeError("focus vector.id");
  if (context !== null && typeof context !== "string")
    throw new TypeError(`${id}: context`);
  if (!("focus" in value)) throw new TypeError(`${id}: focus`);
  return {
    id,
    input: inputOf(input),
    focus: value["focus"],
    context,
    expect: value["expect"],
  };
}

function jsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

export async function readVectors(dir: string): Promise<Vector[]> {
  const text = await readFile(join(dir, "commands.jsonl"), "utf8");
  return jsonl(text).map(parseVector);
}

export async function readFocusVectors(dir: string): Promise<FocusVector[]> {
  const text = await readFile(join(dir, "focus.jsonl"), "utf8");
  return jsonl(text).map(parseFocusVector);
}

export async function vectorBundle(
  dir: string,
  tokenizerPath: string,
): Promise<Bundle> {
  const [labels, tokenizer] = await Promise.all([
    readFile(join(dir, "labels.json"), "utf8"),
    readFile(tokenizerPath, "utf8"),
  ]);
  return parseBundle(JSON.parse(labels), JSON.parse(tokenizer));
}

export async function vectorContext(
  dir: string,
  name: string | null,
): Promise<CompiledContext | null> {
  if (name === null) return null;
  const json: unknown = JSON.parse(
    await readFile(join(dir, "contexts", `${name}.json`), "utf8"),
  );
  return compileContext(parseContext(json));
}

function oneHot(width: number, index: number): number[] {
  if (index < 0 || index >= width)
    throw new RangeError(`index ${String(index)} is outside ${String(width)}`);
  return Array.from({ length: width }, (_, at) => (at === index ? 4 : 0));
}

interface Built {
  readonly text: string;
  readonly offsets: readonly Offset[];
  readonly heads: Heads;
  readonly breaks: ReadonlySet<string>;
}

function built(bundle: Bundle, input: VectorInput): Built {
  const offsets: Offset[] = [[0, 0]];
  let at = 0;
  for (const [word] of input.words) {
    offsets.push([at, at + word.length]);
    at += word.length + 1;
  }
  offsets.push([0, 0]);
  const tag = (name: string) =>
    oneHot(bundle.tags.length, Math.max(0, bundle.tags.indexOf(name)));
  const heads: Heads = {
    action: oneHot(
      bundle.actions.length,
      bundle.actions.findIndex((name) => name === input.action),
    ),
    tags: [tag("O"), ...input.words.map(([, name]) => tag(name)), tag("O")],
    enums: Object.fromEntries(
      Object.entries(bundle.enums).map(([key, values]) => [
        key,
        oneHot(
          values.length,
          Math.max(0, values.indexOf(input.enums[key] ?? "")),
        ),
      ]),
    ),
    segment: null,
    aux: Object.fromEntries(
      Object.entries(bundle.aux).map(([key, values]) => [
        key,
        oneHot(
          values.length,
          Math.max(0, values.indexOf(input.aux[key] ?? "none")),
        ),
      ]),
    ),
    ...(input.lists === undefined ? {} : { lists: input.lists }),
  };
  return {
    text: input.words.map(([word]) => word).join(" "),
    offsets,
    heads,
    breaks: new Set(input.breaks ?? []),
  };
}

interface Part {
  readonly text: string;
  readonly decoded: Decoded;
  readonly refPrevious: Readonly<Record<string, number>>;
  readonly action: Decoded["action"];
  readonly params: Decoded["params"];
  readonly resolved: Decoded["resolved"];
}

function decision(part: Part, now: Now, segmented: boolean): Decision {
  const { decoded } = part;
  const kept = !segmented || part.action === decoded.action;
  return {
    text: part.text,
    action: part.action,
    params: part.params,
    resolved: part.resolved,
    refPrevious: part.refPrevious,
    catalogued: decoded.catalogued,
    actionProbabilities: decoded.actionProbabilities,
    spans: decoded.spans,
    ...(decoded.aux === undefined ? {} : { aux: decoded.aux }),
    ...(decoded.asks === undefined || !kept ? {} : { asks: decoded.asks }),
    ...(decoded.unsupported === undefined || !kept
      ? {}
      : { unsupported: decoded.unsupported }),
    ...(decoded.dropped === undefined || !kept
      ? {}
      : { dropped: decoded.dropped }),
    ...(decoded.ignored === undefined || segmented
      ? {}
      : { ignored: decoded.ignored }),
    now,
  };
}

function decodedPart(
  bundle: Bundle,
  input: VectorInput,
  context: CompiledContext | null,
  now: Now,
): Omit<Part, "refPrevious"> {
  const segment = built(bundle, input);
  const decoded = decode(
    bundle,
    segment.text,
    segment.offsets,
    segment.heads,
    context,
    segment.breaks,
    now,
  );
  return {
    text: segment.text,
    action: decoded.action,
    params: decoded.params,
    resolved: decoded.resolved,
    decoded,
  };
}

export function decodeVector(
  bundle: Bundle,
  vector: Pick<Vector, "input">,
  context: CompiledContext | null,
  now: Now = VECTOR_NOW,
  requirements: Requirements = {},
): CommandV2[] {
  const segmented = Array.isArray(vector.input);
  const inputs = segmented ? vector.input : [vector.input];
  const parts = (inputs as readonly VectorInput[]).map((input) =>
    decodedPart(bundle, input, context, now),
  );
  const filled = segmented
    ? fillReferences(bundle, parts)
    : parts.map((part) => ({ ...part, refPrevious: {} }));
  return filled.map((part) =>
    commandV2(bundle, decision(part, now, segmented), context, requirements),
  );
}

export function decodeFocusVector(
  bundle: Bundle,
  vector: Pick<FocusVector, "input" | "focus">,
  context: CompiledContext | null,
  now: Now = VECTOR_NOW,
): CommandV2 {
  const part = {
    ...decodedPart(bundle, vector.input, context, now),
    refPrevious: {},
  };
  const bound = withFocus(
    bundle,
    decision(part, now, false),
    parseFocus(vector.focus),
  );
  return withCreates(commandV2(bundle, bound, context));
}

export function pinned(command: CommandV2): unknown {
  return JSON.parse(
    JSON.stringify(command, (name: string, value: unknown) =>
      name === "confidence" ? undefined : value,
    ),
  );
}
