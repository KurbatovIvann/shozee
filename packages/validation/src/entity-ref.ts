/**
 * Channel-neutral EntityRef (SHO-352 / ADR-0033): `{ by: "id" } | { by:
 * "query" }`. Query unique-match normalize is Unicode NFC, trim, collapse
 * internal whitespace, then case-fold. Max query length stays 100.
 */
import { z } from "zod";

export const ENTITY_REF_QUERY_MAX = 100;

export const REFERENCE_CONFLICT_LABELS_MAX = 5;

export const entityRefSchema = z.discriminatedUnion("by", [
  z.strictObject({
    by: z.literal("id"),
    id: z.uuid(),
  }),
  z.strictObject({
    by: z.literal("query"),
    value: z.string().trim().min(1).max(ENTITY_REF_QUERY_MAX),
  }),
]);

export type EntityRef = z.output<typeof entityRefSchema>;

/** NFC, trim, collapse internal whitespace. SQL ILIKE uses this (case via ILIKE). */
export function normalizeReferenceQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function normalizeUniqueMatchQuery(query: string): string {
  return normalizeReferenceQuery(query).toLowerCase();
}

export type UniqueMatchResult<T> =
  | { readonly kind: "unique"; readonly row: T }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly rows: readonly T[] };

/**
 * Exact unique match may write. Contains-only hits (candidates that are
 * not an exact normalized field match) become CONFLICT and never
 * auto-choose — even when there is only one contains hit.
 */
export function fieldContainsQuery(
  field: string | null | undefined,
  query: string,
): boolean {
  if (field === null || field === undefined) {
    return false;
  }
  const needle = normalizeUniqueMatchQuery(query);
  if (needle.length === 0) {
    return false;
  }
  return normalizeUniqueMatchQuery(field).includes(needle);
}

export function candidatesContainingQuery<T>(
  query: string,
  rows: readonly T[],
  fieldsOf: (row: T) => readonly (string | null | undefined)[],
): T[] {
  return rows.filter((row) =>
    fieldsOf(row).some((field) => fieldContainsQuery(field, query)),
  );
}

export function pickUniqueNormalizedMatch<T>(
  query: string,
  candidates: readonly T[],
  fieldsOf: (row: T) => readonly (string | null | undefined)[],
): UniqueMatchResult<T> {
  const needle = normalizeUniqueMatchQuery(query);
  if (needle.length === 0) {
    return { kind: "none" };
  }
  const exact: T[] = [];
  for (const row of candidates) {
    const matches = fieldsOf(row).some(
      (field) =>
        field !== null &&
        field !== undefined &&
        normalizeUniqueMatchQuery(field) === needle,
    );
    if (matches) {
      exact.push(row);
    }
  }
  if (exact.length === 1) {
    const row = exact[0];
    if (row === undefined) {
      return { kind: "none" };
    }
    return { kind: "unique", row };
  }
  if (exact.length > 1) {
    return { kind: "ambiguous", rows: exact };
  }
  if (candidates.length > 0) {
    return { kind: "ambiguous", rows: candidates };
  }
  return { kind: "none" };
}

const OBLIQUE_ENDINGS = new Set([
  "а",
  "я",
  "у",
  "ю",
  "і",
  "ї",
  "и",
  "е",
  "є",
  "о",
  "ом",
  "ем",
  "єм",
  "ою",
  "ею",
  "єю",
  "ові",
  "еві",
  "єві",
  "ів",
  "їв",
  "ам",
  "ям",
  "ами",
  "ями",
  "ах",
  "ях",
  "ої",
  "ій",
  "ого",
  "ому",
  "им",
  "ім",
  "их",
  "ими",
]);

const NOMINATIVE_ENDINGS = new Set([
  "",
  "а",
  "я",
  "о",
  "е",
  "є",
  "ь",
  "й",
  "ий",
  "ій",
  "і",
  "и",
  "ї",
]);

const INFLECTION_SHARED_PREFIX_MIN = 2;

function referenceWords(value: string): string[] {
  return normalizeUniqueMatchQuery(value)
    .replaceAll("’", "'")
    .replaceAll("ʼ", "'")
    .split(" ")
    .filter((word) => word.length > 0);
}

export function isInflectionOfWord(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }
  let shared = 0;
  while (
    shared < token.length &&
    shared < word.length &&
    token[shared] === word[shared]
  ) {
    shared += 1;
  }
  return (
    shared >= INFLECTION_SHARED_PREFIX_MIN &&
    shared >= word.length - 2 &&
    OBLIQUE_ENDINGS.has(token.slice(shared)) &&
    NOMINATIVE_ENDINGS.has(word.slice(shared))
  );
}

export function isInflectionOfName(query: string, name: string): boolean {
  const tokens = referenceWords(query);
  const words = referenceWords(name);
  if (tokens.length === 0 || tokens.length !== words.length) {
    return false;
  }
  const free = [...words];
  for (const token of tokens) {
    const at = free.findIndex((word) => isInflectionOfWord(token, word));
    if (at === -1) {
      return false;
    }
    free.splice(at, 1);
  }
  return true;
}

export function pickUniqueReferenceMatch<T>(
  query: string,
  candidates: readonly T[],
  fieldsOf: (row: T) => readonly (string | null | undefined)[],
  nameOf: (row: T) => string,
): UniqueMatchResult<T> {
  const exact = pickUniqueNormalizedMatch(query, candidates, fieldsOf);
  if (exact.kind !== "ambiguous") {
    return exact;
  }
  const hasExactField = candidates.some((row) =>
    fieldsOf(row).some(
      (field) =>
        field !== null &&
        field !== undefined &&
        normalizeUniqueMatchQuery(field) === normalizeUniqueMatchQuery(query),
    ),
  );
  if (hasExactField) {
    return exact;
  }
  const inflected = candidates.filter((row) =>
    isInflectionOfName(query, nameOf(row)),
  );
  const only = inflected[0];
  return inflected.length === 1 && only !== undefined
    ? { kind: "unique", row: only }
    : exact;
}

export function formatReferenceConflictMessage(
  query: string,
  labels: readonly string[],
): string {
  const shown = labels.slice(0, REFERENCE_CONFLICT_LABELS_MAX);
  return `Multiple matches for "${query}": ${shown.join("; ")}.`;
}
