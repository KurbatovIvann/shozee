import type { Tx } from "@showzy/db";
import { and, eq, getTableUniqueName, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

export type RevisionTable = PgTable & {
  readonly revision: AnyPgColumn<{ data: number; notNull: true }>;
  readonly companyId: AnyPgColumn<{ data: string; notNull: true }>;
};

type UuidKeyColumn = AnyPgColumn<{
  data: string;
  notNull: true;
  columnType: "PgUUID";
}>;

type OwnUuidKeyColumn<TTable extends RevisionTable> = Extract<
  TTable["_"]["columns"][keyof TTable["_"]["columns"]],
  UuidKeyColumn
>;

export type RevisionRoot<TTable extends RevisionTable> =
  TTable extends RevisionTable
    ? {
        readonly table: TTable;
        readonly keyColumn: OwnUuidKeyColumn<TTable>;
      }
    : never;

export interface RevisionTarget {
  readonly companyId: string;
  readonly key: string;
}

export type RevisionBump<TTable extends RevisionTable> = RevisionTarget & {
  readonly root: RevisionRoot<TTable>;
};

interface UncheckedRevisionRoot {
  readonly table: RevisionTable;
  readonly keyColumn: UuidKeyColumn;
}

interface UncheckedRevisionBump extends RevisionTarget {
  readonly root: UncheckedRevisionRoot;
}

type CheckedRevisionBump<TBump> = TBump extends {
  readonly root: { readonly table: infer TTable extends RevisionTable };
}
  ? RevisionBump<TTable>
  : never;

async function raiseRevision(
  tx: Tx,
  { table, keyColumn }: UncheckedRevisionRoot,
  target: RevisionTarget,
): Promise<number | undefined> {
  const rows = await tx
    .update(table)
    .set({ revision: sql`${table.revision} + 1` })
    .where(
      and(eq(table.companyId, target.companyId), eq(keyColumn, target.key)),
    )
    .returning({ revision: table.revision });
  return rows[0]?.revision;
}

export function bumpRevision<TTable extends RevisionTable>(
  tx: Tx,
  root: RevisionRoot<TTable>,
  target: RevisionTarget,
): Promise<number | undefined> {
  return raiseRevision(tx, root, target);
}

function lockOrderIdentity(bump: UncheckedRevisionBump): readonly string[] {
  return [
    getTableUniqueName(bump.root.table),
    bump.key.toLowerCase(),
    bump.root.keyColumn.name,
    bump.companyId.toLowerCase(),
  ];
}

function compareIdentities(
  left: readonly string[],
  right: readonly string[],
): number {
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? "";
    if (part !== other) return part < other ? -1 : 1;
  }
  return 0;
}

interface MergedBump {
  readonly bump: UncheckedRevisionBump;
  readonly identity: readonly string[];
  readonly indexes: number[];
}

function mergeEqualRoots(
  bumps: readonly UncheckedRevisionBump[],
): MergedBump[] {
  const merged = new Map<string, MergedBump>();
  bumps.forEach((bump, index) => {
    const identity = lockOrderIdentity(bump);
    const identityKey = JSON.stringify(identity);
    const existing = merged.get(identityKey);
    if (existing) existing.indexes.push(index);
    else merged.set(identityKey, { bump, identity, indexes: [index] });
  });
  return [...merged.values()];
}

export async function bumpRevisions<
  TBumps extends readonly UncheckedRevisionBump[],
>(
  tx: Tx,
  bumps: TBumps & {
    readonly [I in keyof TBumps]: CheckedRevisionBump<TBumps[I]>;
  },
): Promise<(number | undefined)[]> {
  const ordered = mergeEqualRoots(bumps).sort((left, right) =>
    compareIdentities(left.identity, right.identity),
  );
  const revisions: (number | undefined)[] = Array.from({
    length: bumps.length,
  });
  for (const { bump, indexes } of ordered) {
    const revision = await raiseRevision(tx, bump.root, bump);
    for (const index of indexes) revisions[index] = revision;
  }
  return revisions;
}
