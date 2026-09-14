import {
  type AnyPgColumn,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { describe, expectTypeOf, it } from "vitest";

import type {
  bumpRevision,
  bumpRevisions,
  RevisionBump,
  RevisionRoot,
  RevisionTable,
  RevisionTarget,
} from "./revision.js";

const alphaTable = pgTable("revision_type_alpha", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
  note: text("note"),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

const betaTable = pgTable("revision_type_beta", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

type AlphaKeyColumn = RevisionRoot<typeof alphaTable>["keyColumn"];

describe("RevisionRoot", () => {
  it("accepts a non-null string column of its own table as the key", () => {
    expectTypeOf(alphaTable.id).toExtend<AlphaKeyColumn>();
    expectTypeOf(alphaTable.slug).toExtend<AlphaKeyColumn>();
  });

  it("rejects a key column of another table", () => {
    expectTypeOf(betaTable.id).not.toExtend<AlphaKeyColumn>();
  });

  it("rejects a nullable or non-string key column", () => {
    expectTypeOf(alphaTable.note).not.toExtend<AlphaKeyColumn>();
    expectTypeOf(alphaTable.revision).not.toExtend<AlphaKeyColumn>();
  });

  it("rejects every key column when the table type is widened", () => {
    expectTypeOf(alphaTable).toExtend<RevisionTable>();
    expectTypeOf(alphaTable.id).not.toExtend<
      RevisionRoot<RevisionTable>["keyColumn"]
    >();
    expectTypeOf<RevisionRoot<typeof alphaTable>>().not.toExtend<
      RevisionRoot<RevisionTable>
    >();
  });

  it("rejects a mismatched root in a union of tables", () => {
    expectTypeOf<MismatchedRoot>().not.toExtend<
      RevisionRoot<typeof alphaTable | typeof betaTable>
    >();
  });
});

type MismatchedRoot = {
  readonly table: typeof alphaTable;
  readonly keyColumn: typeof betaTable.id;
};

type MismatchedBump = {
  readonly root: MismatchedRoot;
  readonly companyId: string;
  readonly key: string;
};

type WidenedBump = RevisionTarget & {
  readonly root: {
    readonly table: RevisionTable;
    readonly keyColumn: AnyPgColumn<{ data: string; notNull: true }>;
  };
};

type BumpList<TBumps extends readonly WidenedBump[]> = Parameters<
  typeof bumpRevisions<TBumps>
>[1];

describe("bumpRevision", () => {
  it("rejects a root whose table type is widened", () => {
    expectTypeOf<RevisionRoot<typeof alphaTable>>().not.toExtend<
      Parameters<typeof bumpRevision<RevisionTable>>[1]
    >();
  });
});

describe("bumpRevisions", () => {
  it("lets roots of different tables share one bump list", () => {
    type Mixed = readonly [
      RevisionBump<typeof alphaTable>,
      RevisionBump<typeof betaTable>,
    ];
    expectTypeOf<Mixed>().toExtend<BumpList<Mixed>>();
    type MixedArray = readonly (
      RevisionBump<typeof alphaTable> | RevisionBump<typeof betaTable>
    )[];
    expectTypeOf<MixedArray>().toExtend<BumpList<MixedArray>>();
  });

  it("rejects a mismatched root inside the bump list", () => {
    type WithMismatch = readonly [
      RevisionBump<typeof alphaTable>,
      MismatchedBump,
    ];
    expectTypeOf<WithMismatch>().not.toExtend<BumpList<WithMismatch>>();
  });

  it("rejects a root whose table type is widened", () => {
    type Widened = readonly [WidenedBump];
    expectTypeOf<Widened>().not.toExtend<BumpList<Widened>>();
  });
});
