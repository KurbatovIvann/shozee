/**
 * Ukrainian one/few/many cardinal rules and English one/other (mapped
 * onto `many`). Shared count labels — do not copy mod-10/mod-100 into
 * a feature.
 */
import type { Locale } from "./locale.js";

export type CountForms = {
  readonly one: string;
  readonly few: string;
  readonly many: string;
};

export type CountPluralForm = keyof CountForms;

export function countPluralForm(
  count: number,
  locale: Locale,
): CountPluralForm {
  if (locale !== "uk") {
    return count === 1 ? "one" : "many";
  }
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "one";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "few";
  }
  return "many";
}
