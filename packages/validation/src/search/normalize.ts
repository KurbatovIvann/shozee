import { sanitizeLikeLiteral } from "../pagination.js";

import {
  SEARCH_APOSTROPHE_CANON,
  SEARCH_APOSTROPHES,
  SEARCH_DOCUMENT_TYPE_CODES,
  SEARCH_PHONE_MIN_DIGITS,
  SEARCH_QUERY_MAX,
  SEARCH_TOKEN_MAX,
  type SearchDocumentTypeCode,
} from "./constants.js";

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function hasLetterOrDigit(value: string): boolean {
  return LETTER_OR_DIGIT.test(value);
}

export function collapseSearchWhitespace(value: string): string {
  return value.normalize("NFC").trim().replaceAll(/\s+/g, " ");
}

export function foldSearchApostrophes(value: string): string {
  let folded = value;
  for (const mark of SEARCH_APOSTROPHES) {
    folded = folded.replaceAll(mark, SEARCH_APOSTROPHE_CANON);
  }
  return folded;
}

/** Case-fold + apostrophe fold for name tokens (Ukrainian locale). */
export function foldSearchNameToken(value: string): string {
  return foldSearchApostrophes(value).toLocaleLowerCase("uk");
}

export type PreparedSearchQuery =
  | { readonly empty: true; readonly queryNormalized: ""; readonly tokens: [] }
  | {
      readonly empty: false;
      readonly queryNormalized: string;
      readonly tokens: string[];
    };

/**
 * Staff search query normalize (SHO-526 / SHO-527).
 *
 * Empty, punctuation-only (no letters/digits), or LIKE-sanitize-empty →
 * empty-query semantics (`queryNormalized: ""`, no error). Extra tokens
 * beyond `SEARCH_TOKEN_MAX` are dropped, not a VALIDATION error.
 */
export function prepareSearchQuery(raw: string): PreparedSearchQuery {
  const collapsed = collapseSearchWhitespace(raw);
  if (collapsed.length === 0 || !hasLetterOrDigit(collapsed)) {
    return { empty: true, queryNormalized: "", tokens: [] };
  }
  const sanitized = sanitizeLikeLiteral(collapsed);
  if (sanitized === undefined) {
    return { empty: true, queryNormalized: "", tokens: [] };
  }
  const queryNormalized =
    sanitized.length > SEARCH_QUERY_MAX
      ? sanitized.slice(0, SEARCH_QUERY_MAX)
      : sanitized;
  const tokens: string[] = [];
  for (const part of queryNormalized.split(" ")) {
    if (tokens.length >= SEARCH_TOKEN_MAX) {
      break;
    }
    const folded = foldSearchNameToken(part);
    if (folded.length === 0 || !hasLetterOrDigit(folded)) {
      continue;
    }
    tokens.push(folded);
  }
  if (tokens.length === 0) {
    return { empty: true, queryNormalized: "", tokens: [] };
  }
  return { empty: false, queryNormalized, tokens };
}

/**
 * UA national `0XXXXXXXXX` and `+380XXXXXXXXX` become the same `380…`
 * digit string so prefix match works on short national prefixes.
 * Shorter than 5 digits after canonicalize → no phone match.
 */
export function canonicalizePhoneDigits(raw: string): string | undefined {
  const digits = raw.replaceAll(/\D/g, "");
  if (digits.length === 0) {
    return undefined;
  }
  const canonical = digits.startsWith("0") ? `380${digits.slice(1)}` : digits;
  if (canonical.length < SEARCH_PHONE_MIN_DIGITS) {
    return undefined;
  }
  return canonical;
}

export function canonicalizeEmail(raw: string): string | undefined {
  const normalized = raw.trim().toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

export function canonicalizeEdrpou(raw: string): string | undefined {
  const digits = raw.replaceAll(/\D/g, "");
  return digits.length === 0 ? undefined : digits;
}

function foldIdentifier(value: string): string {
  return value.normalize("NFC").trim().toLocaleUpperCase("uk");
}

/**
 * Order numbers: strip `#`, NFC, trim, upper; prepend `{prefix}-` only when
 * there is no `-` **and** the token is not the company prefix alone.
 */
export function canonicalizeOrderNumberToken(
  raw: string,
  companyPrefix: string,
): string | undefined {
  const stripped = foldIdentifier(raw.replaceAll("#", ""));
  if (stripped.length === 0) {
    return undefined;
  }
  const prefix = foldIdentifier(companyPrefix);
  if (stripped === prefix) {
    return undefined;
  }
  if (stripped.includes("-")) {
    return stripped;
  }
  return `${prefix}-${stripped}`;
}

export type CanonicalDocumentNumberQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "none" }
  | { readonly kind: "seq"; readonly sequence: string }
  | { readonly kind: "canonical"; readonly value: string };

function isDocumentTypeCode(value: string): value is SearchDocumentTypeCode {
  return (SEARCH_DOCUMENT_TYPE_CODES as readonly string[]).includes(value);
}

/**
 * Document numbers: **do not** reuse the order algorithm. Bare numeric
 * tokens are a padded sequence (both РХ and ВН), not `{prefix}-{token}`.
 */
export function canonicalizeDocumentNumberQuery(
  raw: string,
  companyPrefix: string,
): CanonicalDocumentNumberQuery {
  const stripped = foldIdentifier(
    raw.replaceAll("#", "").replaceAll(/\s+/g, ""),
  );
  if (stripped.length === 0) {
    return { kind: "empty" };
  }
  const prefix = foldIdentifier(companyPrefix);
  if (stripped === prefix) {
    return { kind: "none" };
  }
  if (!stripped.includes("-")) {
    if (/^\d+$/.test(stripped)) {
      const sequence =
        stripped.length >= 6 ? stripped : stripped.padStart(6, "0");
      return { kind: "seq", sequence };
    }
    return { kind: "none" };
  }
  const parts = stripped.split("-");
  if (parts.length === 2) {
    const typeCode = parts[0];
    const rest = parts[1];
    if (
      typeCode !== undefined &&
      rest !== undefined &&
      rest.length > 0 &&
      isDocumentTypeCode(typeCode)
    ) {
      return { kind: "canonical", value: `${prefix}-${typeCode}-${rest}` };
    }
    return { kind: "none" };
  }
  if (parts.length === 3) {
    return { kind: "canonical", value: stripped };
  }
  return { kind: "none" };
}
