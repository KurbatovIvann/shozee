/**
 * Locale detection and template interpolation shared by every copy
 * namespace. Pure tag mapping lives in `@showzy/copy/locale`. This
 * file binds the device language tag so no-argument `detectLocale()`
 * follows the device after `initAppLocale()`.
 */
import {
  detectLocale as detectLocaleFromTag,
  interpolate,
  type Locale,
} from "@showzy/copy/locale";

export type { Locale };
export { interpolate };

const DEFAULT_LANGUAGE_TAG = "uk";

let resolvedLanguageTag: string | undefined;

/**
 * Bind the device language tag resolved at app start. Later no-argument
 * `detectLocale()` calls use this tag instead of the Ukrainian default.
 */
export function bindResolvedLanguageTag(tag: string): void {
  resolvedLanguageTag = tag;
}

/** True after `initAppLocale` (or a test bind). Used to skip a second read. */
export function isLanguageTagBound(): boolean {
  return resolvedLanguageTag !== undefined;
}

/** Restore the pre-init Ukrainian default. Tests only. */
export function resetResolvedLanguageTagForTests(): void {
  resolvedLanguageTag = undefined;
}

export function detectLocale(
  locale: string = resolvedLanguageTag ?? DEFAULT_LANGUAGE_TAG,
): Locale {
  return detectLocaleFromTag(locale);
}
