import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expectTypeOf, it } from "vitest";

import type { RevisionBump, RevisionRoot, RevisionTable } from "./revision.js";

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

  it("lets roots of different tables share one bump list", () => {
    expectTypeOf(alphaTable).toExtend<RevisionTable>();
    expectTypeOf<RevisionRoot<typeof alphaTable>>().toExtend<
      RevisionBump["root"]
    >();
    expectTypeOf<RevisionRoot<typeof betaTable>>().toExtend<
      RevisionBump["root"]
    >();
  });
});
