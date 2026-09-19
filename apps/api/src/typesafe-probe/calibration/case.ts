import type { ExpectedCall } from "../followup/corpus.js";

export const CALIBRATION_TRAITS = [
  "direct",
  "colloquial",
  "inflected",
  "trap",
  "unsupported",
  "talk",
  "other_job",
] as const;

export type CalibrationTrait = (typeof CALIBRATION_TRAITS)[number];

export interface CalibrationCase {
  readonly id: string;
  readonly split: "tune" | "holdout";
  readonly group: string;
  readonly trait: CalibrationTrait;
  readonly message: string;
  readonly expected: ExpectedCall | null;
  readonly alsoOk?: readonly ExpectedCall[];
}
