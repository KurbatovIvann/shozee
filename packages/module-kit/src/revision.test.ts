import { fileURLToPath } from "node:url";

import {
  type AnyPgColumn,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import ts from "typescript";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

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

const alphaTwinTable = pgTable("revision_type_alpha", {
  id: uuid("id").primaryKey(),
  externalId: uuid("external_id").notNull(),
  companyId: uuid("company_id").notNull(),
  revision: integer("revision").notNull().default(1),
});

type AlphaKeyColumn = RevisionRoot<typeof alphaTable>["keyColumn"];

describe("RevisionRoot", () => {
  it("accepts a non-null uuid column of its own table as the key", () => {
    expectTypeOf(alphaTable.id).toExtend<AlphaKeyColumn>();
    expectTypeOf(alphaTable.companyId).toExtend<AlphaKeyColumn>();
  });

  it("rejects a key column of another table", () => {
    expectTypeOf(betaTable.id).not.toExtend<AlphaKeyColumn>();
  });

  it("rejects a key column of a same-named table that its own table lacks", () => {
    expectTypeOf(alphaTwinTable.externalId).not.toExtend<AlphaKeyColumn>();
  });

  it("rejects a text, nullable, or non-string key column", () => {
    expectTypeOf(alphaTable.slug).not.toExtend<AlphaKeyColumn>();
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
    readonly keyColumn: AnyPgColumn<{
      data: string;
      notNull: true;
      columnType: "PgUUID";
    }>;
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

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function callSiteSource(keyColumn: string): string {
  return [
    'import type { Tx } from "@showzy/db";',
    'import { integer, pgTable, uuid } from "drizzle-orm/pg-core";',
    'import { bumpRevisions } from "./revision.js";',
    "declare const tx: Tx;",
    'const alphaTable = pgTable("call_site_alpha", { id: uuid("id").primaryKey(), companyId: uuid("company_id").notNull(), revision: integer("revision").notNull() });',
    'const betaTable = pgTable("call_site_beta", { id: uuid("id").primaryKey(), companyId: uuid("company_id").notNull(), revision: integer("revision").notNull() });',
    `export const probe = bumpRevisions(tx, [{ root: { table: alphaTable, keyColumn: ${keyColumn} }, companyId: "company", key: "key" }]);`,
    "export const tables = [alphaTable, betaTable];",
  ].join("\n");
}

function inlineCallDiagnostics(
  probes: Record<string, string>,
): Record<string, readonly string[]> {
  const configPath = ts.findConfigFile(packageRoot, (path) =>
    ts.sys.fileExists(path),
  );
  if (!configPath) throw new RangeError("module-kit tsconfig not found");
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, (path) => ts.sys.readFile(path)).config,
    ts.sys,
    packageRoot,
  );
  const probeFiles = new Map(
    Object.entries(probes).map(([name, source]) => [
      ts.sys.resolvePath(`${packageRoot}src/${name}.ts`).replaceAll("\\", "/"),
      source,
    ]),
  );
  const host = ts.createCompilerHost(config.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const probeSource = (fileName: string): string | undefined =>
    probeFiles.get(fileName.replaceAll("\\", "/"));
  host.readFile = (fileName) => probeSource(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) =>
    probeSource(fileName) !== undefined || fileExists(fileName);
  const program = ts.createProgram(
    [...probeFiles.keys()],
    config.options,
    host,
  );
  return Object.fromEntries(
    [...probeFiles.keys()].map((fileName, index) => {
      const sourceFile = program.getSourceFile(fileName);
      const diagnostics = sourceFile
        ? program.getSemanticDiagnostics(sourceFile)
        : [];
      return [
        Object.keys(probes)[index] ?? fileName,
        diagnostics.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
      ];
    }),
  );
}

describe("bumpRevisions at an inline call site", () => {
  let diagnostics: Record<string, readonly string[]>;

  beforeAll(() => {
    diagnostics = inlineCallDiagnostics({
      "revision-call-site-own-key": callSiteSource("alphaTable.id"),
      "revision-call-site-foreign-key": callSiteSource("betaTable.id"),
    });
  }, 120_000);

  it("compiles a root keyed by its own table's column", () => {
    expect(diagnostics["revision-call-site-own-key"]).toEqual([]);
  });

  it("rejects a root keyed by another table's column", () => {
    expect(diagnostics["revision-call-site-foreign-key"]).toHaveLength(1);
  });
});
