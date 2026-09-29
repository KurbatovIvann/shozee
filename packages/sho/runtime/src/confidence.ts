import { BundleError } from "./errors.ts";

// How sure the model is of the action (design sho-runtime.md §2.2): the top softmax probability, its margin over the second, and 1 − H/ln N.
export interface Confidence {
  readonly action: number;
  readonly margin: number;
  readonly certainty: number;
}

export function confidenceOf(probabilities: readonly number[]): Confidence {
  const [top = 0, second = 0] = [...probabilities].sort((a, b) => b - a);
  const entropy = probabilities.reduce((sum, probability) => (probability > 0 ? sum - probability * Math.log(probability) : sum), 0);
  const certainty = probabilities.length > 1 ? 1 - entropy / Math.log(probabilities.length) : 1;
  return { action: top, margin: top - second, certainty };
}

// D87: the bundle's calibration (`calibration.json` beside `labels.json`): the temperature T of the action head, fitted on the trainer's holdout of the
// bundle's mix (`sho.eval.calibrate`). Absent, T is 1 and the confidence is the raw softmax, as for every bundle before D87.
export const CALIBRATION_FORMAT = "sho-calibration/1";

export interface Calibration {
  readonly actionTemperature: number;
}

export const UNCALIBRATED: Calibration = { actionTemperature: 1 };

export function parseCalibration(json: unknown): Calibration {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new BundleError("calibration", "calibration is not an object");
  const format: unknown = Reflect.get(json, "format");
  if (format !== CALIBRATION_FORMAT) throw new BundleError("calibration", `calibration format is ${String(format)}, not ${CALIBRATION_FORMAT}`);
  const temperature: unknown = Reflect.get(json, "action_temperature");
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature <= 0) throw new BundleError("calibration", "action_temperature is not a positive number");
  return { actionTemperature: temperature };
}

// The softmax of logits / T from the softmax of the logits: p_i^(1/T), normalised. T = 1 gives the probabilities back unchanged.
export function tempered(probabilities: readonly number[], temperature: number): readonly number[] {
  if (temperature === 1 || !probabilities.length) return probabilities;
  const logs = probabilities.map((probability) => (probability > 0 ? Math.log(probability) / temperature : Number.NEGATIVE_INFINITY));
  const top = Math.max(...logs);
  const exps = logs.map((value) => Math.exp(value - top));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}
