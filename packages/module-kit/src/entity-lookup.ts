import { ConflictError, NotFoundError } from "@showzy/core/errors";
import {
  normalizeUniqueMatchQuery,
  pickUniqueReferenceMatch,
} from "@showzy/validation/entity-ref";

export const ENTITY_LOOKUP_OPTIONS_MAX = 20;

export type EntityLookupTarget = {
  readonly kind: "customer" | "product";
  readonly query: string;
};

export type EntityLookupOption = {
  readonly id: string;
  readonly label: string;
};

export type EntityLookupMatch<T> =
  | { readonly kind: "unique"; readonly row: T }
  | { readonly kind: "several"; readonly rows: readonly T[] }
  | { readonly kind: "nearest"; readonly rows: readonly T[] }
  | { readonly kind: "none" };

export function classifyEntityLookupMatch<T>(
  query: string,
  candidates: readonly T[],
  fieldsOf: (row: T) => readonly (string | null | undefined)[],
  nameOf: (row: T) => string,
): EntityLookupMatch<T> {
  const picked = pickUniqueReferenceMatch(query, candidates, fieldsOf, nameOf);
  if (picked.kind === "unique") {
    return { kind: "unique", row: picked.row };
  }
  if (picked.kind === "none") {
    return { kind: "none" };
  }
  const needle = normalizeUniqueMatchQuery(query);
  const exact = picked.rows.filter((row) =>
    fieldsOf(row).some(
      (field) =>
        field !== null &&
        field !== undefined &&
        normalizeUniqueMatchQuery(field) === needle,
    ),
  );
  return exact.length > 0
    ? { kind: "several", rows: exact }
    : { kind: "nearest", rows: picked.rows };
}

export type EntityLookupPicker = {
  readonly options: readonly EntityLookupOption[];
  readonly optionsTruncated: boolean;
};

export function entityLookupPicker(
  options: readonly EntityLookupOption[],
): EntityLookupPicker {
  const sorted = [...options].toSorted((left, right) => {
    const byLabel = left.label.localeCompare(right.label);
    return byLabel === 0 ? left.id.localeCompare(right.id) : byLabel;
  });
  return {
    options: sorted.slice(0, ENTITY_LOOKUP_OPTIONS_MAX),
    optionsTruncated: sorted.length > ENTITY_LOOKUP_OPTIONS_MAX,
  };
}

export class EntityLookupAmbiguousError extends ConflictError {
  readonly reason = "ambiguous";
  readonly target: EntityLookupTarget;
  readonly options: readonly EntityLookupOption[];
  readonly optionsTruncated: boolean;

  constructor(target: EntityLookupTarget, picker: EntityLookupPicker) {
    super(`Select a ${target.kind} matching "${target.query}".`);
    this.target = target;
    this.options = picker.options;
    this.optionsTruncated = picker.optionsTruncated;
  }
}

export class EntityLookupUnmatchedError extends NotFoundError {
  readonly reason = "unmatched_query";
  readonly target: EntityLookupTarget;
  readonly options: readonly EntityLookupOption[];
  readonly optionsTruncated: boolean;

  constructor(target: EntityLookupTarget, picker: EntityLookupPicker) {
    super(`Nothing matches "${target.query}".`);
    this.target = target;
    this.options = picker.options;
    this.optionsTruncated = picker.optionsTruncated;
  }
}

export function entityLookupRefusal(
  target: EntityLookupTarget,
  match: Exclude<EntityLookupMatch<never>["kind"], "unique">,
  options: readonly EntityLookupOption[],
): EntityLookupAmbiguousError | EntityLookupUnmatchedError {
  const picker = entityLookupPicker(options);
  return match === "several"
    ? new EntityLookupAmbiguousError(target, picker)
    : new EntityLookupUnmatchedError(target, picker);
}
