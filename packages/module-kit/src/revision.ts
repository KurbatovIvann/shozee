import type { Tx } from "@showzy/db";
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

export type RevisionTable = PgTable & {
  readonly revision: AnyPgColumn<{ data: number; notNull: true }>;
  readonly companyId: AnyPgColumn<{ data: string; notNull: true }>;
};

export interface RevisionRoot<TTable extends RevisionTable = RevisionTable> {
  readonly table: TTable;
  readonly keyColumn: AnyPgColumn<{ data: string; notNull: true }>;
}

export interface RevisionTarget {
  readonly companyId: string;
  readonly key: string;
}

export interface RevisionBump extends RevisionTarget {
  readonly root: RevisionRoot;
}

export async function bumpRevision(
  tx: Tx,
  root: RevisionRoot,
  target: RevisionTarget,
): Promise<number | undefined> {
  const { table, keyColumn } = root;
  const rows = await tx
    .update(table)
    .set({ revision: sql`${table.revision} + 1` })
    .where(
      and(eq(table.companyId, target.companyId), eq(keyColumn, target.key)),
    )
    .returning({ revision: table.revision });
  return rows[0]?.revision;
}

function compareBumps(left: RevisionBump, right: RevisionBump): number {
  const leftTable = getTableName(left.root.table);
  const rightTable = getTableName(right.root.table);
  if (leftTable !== rightTable) return leftTable < rightTable ? -1 : 1;
  const leftKey = left.key.toLowerCase();
  const rightKey = right.key.toLowerCase();
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

function rootIdentity(bump: RevisionBump): string {
  return JSON.stringify([
    getTableName(bump.root.table),
    bump.companyId.toLowerCase(),
    bump.key.toLowerCase(),
  ]);
}

interface MergedBump {
  readonly bump: RevisionBump;
  readonly indexes: number[];
}

function mergeEqualRoots(bumps: readonly RevisionBump[]): MergedBump[] {
  const merged = new Map<string, MergedBump>();
  bumps.forEach((bump, index) => {
    const identity = rootIdentity(bump);
    const existing = merged.get(identity);
    if (existing) existing.indexes.push(index);
    else merged.set(identity, { bump, indexes: [index] });
  });
  return [...merged.values()];
}

export async function bumpRevisions(
  tx: Tx,
  bumps: readonly RevisionBump[],
): Promise<(number | undefined)[]> {
  const ordered = mergeEqualRoots(bumps).sort((left, right) =>
    compareBumps(left.bump, right.bump),
  );
  const revisions: (number | undefined)[] = Array.from({
    length: bumps.length,
  });
  for (const { bump, indexes } of ordered) {
    const revision = await bumpRevision(tx, bump.root, bump);
    for (const index of indexes) revisions[index] = revision;
  }
  return revisions;
}
