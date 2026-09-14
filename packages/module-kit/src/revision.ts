import type { Tx } from "@showzy/db";
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

export type RevisionTable = PgTable & {
  readonly revision: AnyPgColumn<{ data: number; notNull: true }>;
  readonly companyId: AnyPgColumn<{ data: string; notNull: true }>;
};

type LiteralTableName<TTable extends RevisionTable> =
  string extends TTable["_"]["name"] ? never : TTable["_"]["name"];

export type RevisionRoot<TTable extends RevisionTable> =
  TTable extends RevisionTable
    ? {
        readonly table: TTable;
        readonly keyColumn: AnyPgColumn<{
          data: string;
          notNull: true;
          tableName: LiteralTableName<TTable>;
        }>;
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
  readonly keyColumn: AnyPgColumn<{ data: string; notNull: true }>;
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

function compareBumps(
  left: UncheckedRevisionBump,
  right: UncheckedRevisionBump,
): number {
  const leftTable = getTableName(left.root.table);
  const rightTable = getTableName(right.root.table);
  if (leftTable !== rightTable) return leftTable < rightTable ? -1 : 1;
  const leftKey = left.key.toLowerCase();
  const rightKey = right.key.toLowerCase();
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

function rootIdentity(bump: UncheckedRevisionBump): string {
  return JSON.stringify([
    getTableName(bump.root.table),
    bump.companyId.toLowerCase(),
    bump.key.toLowerCase(),
  ]);
}

interface MergedBump {
  readonly bump: UncheckedRevisionBump;
  readonly indexes: number[];
}

function mergeEqualRoots(
  bumps: readonly UncheckedRevisionBump[],
): MergedBump[] {
  const merged = new Map<string, MergedBump>();
  bumps.forEach((bump, index) => {
    const identity = rootIdentity(bump);
    const existing = merged.get(identity);
    if (existing) existing.indexes.push(index);
    else merged.set(identity, { bump, indexes: [index] });
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
    compareBumps(left.bump, right.bump),
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
