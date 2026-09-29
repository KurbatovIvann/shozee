import { MEASURE_SCALES } from "./lexicon/units.ts";

// A number with a unit of weight, volume, length or power, in the unit's smallest measure (D66): «0.5 kg» and «500 g» are one weight, «1.2 m» and «120 cm»
// one length. Tokens are `nameTokens` output: a number in digits, then the unit's key.

export interface Measure {
  readonly dimension: string;
  readonly base: number;
}

const NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;
const PRECISION = 1e6;

// The measure a number and the unit key after it say, at `at`; null for anything else.
export function measureAt(tokens: readonly string[], at: number): Measure | null {
  const number = tokens[at];
  const scale = MEASURE_SCALES.get(tokens[at + 1] ?? "");
  if (number === undefined || scale === undefined || !NUMBER.test(number)) return null;
  return { dimension: scale[0], base: Math.round(Number(number) * scale[1] * PRECISION) / PRECISION };
}

export function sameMeasure(left: Measure, right: Measure): boolean {
  return left.dimension === right.dimension && left.base === right.base;
}

// The key a number and its unit are both posted under, whatever the unit (`NameIndex`): «500 g» and «0.5 kg» share it.
export function measureKey(measure: Measure): string {
  return `#${measure.dimension}:${measure.base}`;
}
