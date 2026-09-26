/**
 * Shared list-pagination toolkit (SHO-284 / validation-T1).
 *
 * Cursor codec (typed per sort key), `limit` / `cursor` / search Zod
 * input fragments, LIKE-metacharacter sanitizer, name-search token
 * stems (SHO-396 / SHO-397), and the limit+1 → `hasMore` → `nextCursor`
 * epilogue. Sort keys, default limits (20/50), and cursor payload
 * shapes stay at the call site.
 */
import { z } from "zod";

export type CursorFieldKind =
  "isoDatetime" | "uuid" | "booleanFlag" | "int" | "remainder";

export type CursorField<K extends string = string> = {
  readonly key: K;
  readonly kind: CursorFieldKind;
};

type EncodeValueFor<K extends CursorFieldKind> = K extends "isoDatetime"
  ? Date
  : K extends "booleanFlag"
    ? boolean
    : K extends "int"
      ? number
      : string;

export type CursorEncodeInput<F extends readonly CursorField[]> = {
  [I in F[number] as I["key"]]: EncodeValueFor<I["kind"]>;
};

function encodeField(
  kind: CursorFieldKind,
  value: Date | string | boolean | number,
): string {
  switch (kind) {
    case "isoDatetime":
      return (value as Date).toISOString();
    case "booleanFlag":
      return value ? "1" : "0";
    case "int":
      return (value as number).toString(10);
    case "uuid":
    case "remainder":
      return value as string;
  }
}

function decodeField(
  kind: CursorFieldKind,
  raw: string,
): string | boolean | number | undefined {
  switch (kind) {
    case "isoDatetime":
    case "uuid":
    case "remainder":
      return raw;
    case "booleanFlag":
      if (raw !== "0" && raw !== "1") {
        return undefined;
      }
      return raw === "1";
    case "int":
      if (!/^-?\d+$/.test(raw)) {
        return undefined;
      }
      return Number.parseInt(raw, 10);
  }
}

/**
 * Pipe-separated cursor codec. The last field may be `remainder` so a
 * display name that contains `|` is the suffix after the earlier
 * separators. Datetime fields encode from `Date` (`toISOString`) and
 * decode as ISO strings through the payload schema.
 */
export function createCursorCodec<
  TOutput,
  const F extends readonly CursorField<Extract<keyof TOutput, string>>[],
>(options: {
  readonly payload: z.ZodType<TOutput>;
  readonly fields: F;
}): {
  encode(values: CursorEncodeInput<F>): string;
  decode(cursor: string): TOutput | undefined;
} {
  const { payload, fields } = options;
  const remainderLast =
    fields[fields.length - 1]?.kind === "remainder" ? fields.length - 1 : -1;

  return {
    encode(values) {
      const record = values as Record<string, Date | string | boolean | number>;
      return fields
        .map((field) => {
          const value = record[field.key];
          if (value === undefined) {
            return encodeField(field.kind, "");
          }
          return encodeField(field.kind, value);
        })
        .join("|");
    },
    decode(cursor) {
      const parts = cursor.split("|");
      if (remainderLast === -1) {
        if (parts.length !== fields.length) {
          return undefined;
        }
      } else if (parts.length < fields.length) {
        return undefined;
      }

      const decoded: Record<string, string | boolean | number> = {};
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field === undefined) {
          return undefined;
        }
        const raw =
          index === remainderLast
            ? parts.slice(index).join("|")
            : (parts[index] ?? "");
        const value = decodeField(field.kind, raw);
        if (value === undefined) {
          return undefined;
        }
        decoded[field.key] = value;
      }

      const parsed = payload.safeParse(decoded);
      return parsed.success ? parsed.data : undefined;
    },
  };
}

export function listLimitInput(max: number, defaultLimit: number) {
  return z.number().int().min(1).max(max).default(defaultLimit);
}

export function listSearchInput(max: number) {
  return z.string().trim().min(1).max(max).optional();
}

export function listCursorInput(
  parse: (cursor: string) => unknown,
  maxLength: number,
) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => parse(value) !== undefined, {
      message: "Invalid cursor",
    })
    .optional();
}

/**
 * Strip LIKE metacharacters so they cannot widen or escape an `ilike`
 * match. Empty remainder means "return no rows" at the call site.
 */
export function sanitizeLikeLiteral(query: string): string | undefined {
  const literal = query
    .replaceAll("\\", "")
    .replaceAll("%", "")
    .replaceAll("_", "");
  if (literal.length === 0) {
    return undefined;
  }
  return literal;
}

/** Catalog-golden contains pattern (`%literal%`) after sanitizing. */
export function likeContainsPattern(query: string): string | undefined {
  const literal = sanitizeLikeLiteral(query);
  if (literal === undefined) {
    return undefined;
  }
  return `%${literal}%`;
}

export function stemNameToken(token: string): string {
  if (token.length >= 6) {
    return token.slice(0, -2);
  }
  if (token.length >= 4) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Token stems for staff name search (SHO-396 / SHO-397).
 *
 * Sanitizes LIKE metacharacters, NFC-normalizes, splits on whitespace,
 * then shortens each token (≥6 drop last 2, ≥4 drop last 1, else keep).
 * Returns unique non-empty stems in token order. An empty list means
 * "match nothing" at the call site (same as a stripped LIKE remainder).
 *
 * Callers AND-match each stem as `ILIKE %stem%` on a **name** field.
 * Phone, email, and identifier fields keep full-string contains.
 */
export function nameSearchStems(query: string): string[] {
  const literal = sanitizeLikeLiteral(query);
  if (literal === undefined) {
    return [];
  }

  const normalized = literal.normalize("NFC").trim().replaceAll(/\s+/g, " ");
  if (normalized.length === 0) {
    return [];
  }

  const stems: string[] = [];
  const seen = new Set<string>();
  for (const token of normalized.split(" ")) {
    const stem = stemNameToken(token);
    if (stem.length === 0 || seen.has(stem)) {
      continue;
    }
    seen.add(stem);
    stems.push(stem);
  }
  return stems;
}

export function paginate<T>(
  rows: readonly T[],
  limit: number,
  encodeCursor: (last: T) => string,
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : [...rows];
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last) : null;
  return { page, nextCursor };
}
