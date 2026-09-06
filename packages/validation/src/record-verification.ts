/**
 * One verification policy point (SHO-466 / SHO-464).
 *
 * Answers "does this record count?" for writes, totals, lists and
 * aggregates. Flipping enforcement to "everything not created via `ui`
 * is unvouched" is a change to `RECORD_VERIFICATION.mode` — not a
 * re-audit of every query.
 *
 * Lives in `@showzy/validation` because the predicate is pure (row +
 * policy → boolean) and needs no action runtime. T3 (contract-check in
 * `@showzy/core`) stays a disjoint path. Channel strings match
 * `ActionChannel` / `created_via` CHECK; this package does not import
 * core or db.
 *
 * ## Counting (narrow default)
 *
 * `narrow`: nothing is unvouched. Every row counts, including
 * `created_via: 'ai'` with `vouched_by` null. Default so no total moves.
 *
 * `strict`: a row is unvouched when `created_via` is a known non-`ui`
 * channel and `vouched_by` is null. Pre-migration `created_via = NULL`
 * still counts (grandfathering). T1 left those columns honest rather
 * than guessing `'ui'`; unknown provenance is not evidence the
 * assistant wrote the row.
 *
 * Queries must call `recordCounts` / `recordCountsSql` (same spec). Do
 * not add a second `WHERE vouched_by IS NOT NULL`.
 *
 * ## Writes (vouch after an update)
 *
 * Whether an AI update clears `vouched_by` differs by kind, encoded in
 * `RECORD_VOUCH_ON_WRITE` — not in module handlers.
 *
 * A **content** edit by `ai` on a vouched record **clears** the vouch:
 * the human attested to the previous content, not the new one. The
 * record stays complete (not a draft) but is unattested until a human
 * re-vouches.
 *
 * A **state transition** by `ai` (`orders.confirm` and the other
 * lifecycle verbs performed at the staff member's request) **keeps**
 * the vouch. Knocking that order out of revenue would mix the
 * commercial fact with provenance. UI / system / webhook writes never
 * clear an existing vouch.
 *
 * Call `vouchAfterWrite` when a later ticket writes `vouched_by`. Do
 * not copy these branches into handlers.
 */
export type RecordCreatedVia = "ui" | "ai" | "system" | "webhook";

export type RecordVerificationMode = "narrow" | "strict";

export type RecordProvenance = {
  readonly createdVia: RecordCreatedVia | null;
  readonly vouchedBy: string | null;
};

export const RECORD_VERIFICATION_POLICIES = {
  narrow: {
    unvouched: "none",
    grandfatherUnknownCreatedVia: true,
  },
  strict: {
    unvouched: "non_ui_without_vouch",
    countedCreatedVia: "ui",
    grandfatherUnknownCreatedVia: true,
  },
} as const;

/**
 * Active mode. Production stays `"narrow"` (SHO-466). Flip this field
 * to `"strict"` — that is the only source edit totals need in order to
 * exclude unvouched rows.
 */
export const RECORD_VERIFICATION: { mode: RecordVerificationMode } = {
  mode: "narrow",
};

export type RecordCountClause =
  | { readonly field: "createdVia"; readonly op: "isNull" }
  | {
      readonly field: "createdVia";
      readonly op: "eq";
      readonly value: "ui";
    }
  | { readonly field: "vouchedBy"; readonly op: "isNotNull" };

export type RecordCountSpec =
  | { readonly kind: "all" }
  | { readonly kind: "or"; readonly clauses: readonly RecordCountClause[] };

export type RecordProvenanceColumns<TCreatedVia, TVouchedBy> = {
  readonly createdVia: TCreatedVia;
  readonly vouchedBy: TVouchedBy;
};

export type RecordCountSqlOps<TCreatedVia, TVouchedBy, TSql> = {
  readonly alwaysTrue: TSql;
  readonly isNull: (column: TCreatedVia) => TSql;
  readonly isNotNull: (column: TVouchedBy) => TSql;
  readonly eq: (column: TCreatedVia, value: "ui") => TSql;
  readonly or: (clauses: readonly TSql[]) => TSql;
};

export type RecordWriteKind = "content" | "state_transition";

export type VouchAfterWrite = "keep" | "clear";

/**
 * Per-channel write rule. Data, not handler branches. See the file
 * comment for why content and state_transition differ on `ai`.
 */
export const RECORD_VOUCH_ON_WRITE = {
  ai: {
    content: "clear",
    state_transition: "keep",
  },
  ui: {
    content: "keep",
    state_transition: "keep",
  },
  system: {
    content: "keep",
    state_transition: "keep",
  },
  webhook: {
    content: "keep",
    state_transition: "keep",
  },
} as const satisfies Record<
  RecordCreatedVia,
  Record<RecordWriteKind, VouchAfterWrite>
>;

export function recordCountSpec(
  mode: RecordVerificationMode = RECORD_VERIFICATION.mode,
): RecordCountSpec {
  const policy = RECORD_VERIFICATION_POLICIES[mode];
  if (policy.unvouched === "none") {
    return { kind: "all" };
  }
  const clauses: RecordCountClause[] = [];
  if (policy.grandfatherUnknownCreatedVia) {
    clauses.push({ field: "createdVia", op: "isNull" });
  }
  clauses.push({
    field: "createdVia",
    op: "eq",
    value: policy.countedCreatedVia,
  });
  clauses.push({ field: "vouchedBy", op: "isNotNull" });
  return { kind: "or", clauses };
}

function clauseMatches(
  clause: RecordCountClause,
  row: RecordProvenance,
): boolean {
  if (clause.field === "createdVia") {
    if (clause.op === "isNull") {
      return row.createdVia === null;
    }
    return row.createdVia === clause.value;
  }
  return row.vouchedBy !== null;
}

function clauseSql<TCreatedVia, TVouchedBy, TSql>(
  clause: RecordCountClause,
  columns: RecordProvenanceColumns<TCreatedVia, TVouchedBy>,
  ops: RecordCountSqlOps<TCreatedVia, TVouchedBy, TSql>,
): TSql {
  if (clause.field === "createdVia") {
    if (clause.op === "isNull") {
      return ops.isNull(columns.createdVia);
    }
    return ops.eq(columns.createdVia, clause.value);
  }
  return ops.isNotNull(columns.vouchedBy);
}

/** Whether the row counts in totals / aggregates under the active policy. */
export function recordCounts(
  row: RecordProvenance,
  mode: RecordVerificationMode = RECORD_VERIFICATION.mode,
): boolean {
  const spec = recordCountSpec(mode);
  if (spec.kind === "all") {
    return true;
  }
  return spec.clauses.some((clause) => clauseMatches(clause, row));
}

/**
 * SQL translation of `recordCounts` over the row's provenance columns.
 * Bind drizzle (or any SQL builder) through `ops` — the decision stays
 * in `recordCountSpec`.
 */
export function recordCountsSql<TCreatedVia, TVouchedBy, TSql>(
  columns: RecordProvenanceColumns<TCreatedVia, TVouchedBy>,
  ops: RecordCountSqlOps<TCreatedVia, TVouchedBy, TSql>,
  mode: RecordVerificationMode = RECORD_VERIFICATION.mode,
): TSql {
  const spec = recordCountSpec(mode);
  if (spec.kind === "all") {
    return ops.alwaysTrue;
  }
  return ops.or(spec.clauses.map((clause) => clauseSql(clause, columns, ops)));
}

/**
 * Whether a write should clear an existing `vouched_by`. Already-null
 * stays null (`keep`). See the file comment for the content vs
 * state-transition decision.
 */
export function vouchAfterWrite(input: {
  readonly channel: RecordCreatedVia;
  readonly writeKind: RecordWriteKind;
  readonly vouchedBy: string | null;
}): VouchAfterWrite {
  if (input.vouchedBy === null) {
    return "keep";
  }
  return RECORD_VOUCH_ON_WRITE[input.channel][input.writeKind];
}
