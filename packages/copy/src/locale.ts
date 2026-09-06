/**
 * Locale detection and template interpolation shared by every copy
 * namespace. V1 shipped Ukrainian and English; V2 keeps the same pair.
 * Ukrainian is the product default (UA-first). English only when the
 * locale is explicitly `en*`.
 *
 * `detectLocale(tag)` is pure. Device binding stays in each app.
 */

export type Locale = "en" | "uk";

export function detectLocale(locale: string = "uk"): Locale {
  return locale.toLowerCase().startsWith("en") ? "en" : "uk";
}

export function interpolate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(vars, key)) {
      return "";
    }
    return vars[key] ?? "";
  });
}

export function selectCopy<T>(
  locale: Locale,
  copies: { readonly uk: T; readonly en: T },
): T {
  return locale === "uk" ? copies.uk : copies.en;
}
