import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import {
  PROVENANCE_TABLE_EXPORTS,
  RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS,
  moduleSourcePath,
  recordVerificationAggregatesRule,
  toPosix,
} from "./record-verification-aggregates.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * @param {string} relative
 */
function file(relative) {
  return path.join(repoRoot, relative);
}

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

const UNDECLARED_AGGREGATE = `
  import { orders } from "@showzy/db/schema/orders";
  import { count } from "drizzle-orm";
  export const total = count();
`;

const CONSULTING_AGGREGATE = `
  import { orders } from "@showzy/db/schema/orders";
  import { recordCountsSql } from "@showzy/validation/record-verification";
  import { count } from "drizzle-orm";
  export const total = count();
  export const predicate = recordCountsSql;
`;

test("toPosix is identical on Windows and Linux separators", () => {
  const posix = "packages/modules/orders/src/services/order-list/aggregate.ts";
  const windows = posix.replaceAll("/", "\\");
  assert.equal(toPosix(windows), posix);
  assert.equal(toPosix(posix), posix);
  assert.equal(toPosix(`C:\\repo\\${windows}`), `C:/repo/${posix}`);
});

test("moduleSourcePath matches exemption keys without depending on separators", () => {
  const relative =
    "packages/modules/customers/src/services/count-active-members.ts";
  assert.equal(moduleSourcePath(relative), relative);
  assert.equal(moduleSourcePath(relative.replaceAll("/", "\\")), relative);
  assert.equal(
    moduleSourcePath(`D:\\work\\showzy-v2\\${relative.replaceAll("/", "\\")}`),
    relative,
  );
  assert.equal(moduleSourcePath("packages/tooling/eslint/base.mjs"), null);
});

test("RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS is a frozen posix map with inline reasons", () => {
  assert.ok(Object.isFrozen(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS));
  const keys = Object.keys(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS).sort();
  assert.deepEqual(keys, [
    "packages/modules/catalog/src/actions/list-products.ts",
    "packages/modules/customers/src/services/count-active-members.ts",
    "packages/modules/customers/src/services/count-linked-counterparties.ts",
    "packages/modules/orders/src/services/order-list/page.ts",
    "packages/modules/pricing/src/services/count-price-list-entries.ts",
  ]);
  for (const key of keys) {
    assert.equal(key, toPosix(key));
    assert.equal(key.includes("\\"), false);
    assert.ok(
      RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS[key].length > 0,
      `${key} must carry an inline reason`,
    );
  }
});

test("showzy/record-verification-aggregates", () => {
  tester.run(
    "showzy/record-verification-aggregates",
    recordVerificationAggregatesRule,
    {
      valid: [
        {
          filename: file(
            "packages/modules/orders/src/services/order-list/aggregate.ts",
          ),
          code: CONSULTING_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/customers/src/services/count-active-members.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/customers/src/services/count-linked-counterparties.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/pricing/src/services/count-price-list-entries.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/catalog/src/actions/list-products.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/orders/src/services/order-list/page.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: `C:\\repo\\packages\\modules\\customers\\src\\services\\count-active-members.ts`,
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/files/src/services/count-objects.ts",
          ),
          code: `
            import { files } from "@showzy/db/schema/files";
            import { count } from "drizzle-orm";
            export const n = count();
          `,
        },
        {
          filename: file("packages/modules/orders/src/services/load-order.ts"),
          code: `
            import { orders } from "@showzy/db/schema/orders";
            import { eq } from "drizzle-orm";
            export const id = orders.id;
            export const same = eq;
          `,
        },
        {
          filename: file(
            "packages/core/src/runtime/pipeline/execute-action.ts",
          ),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file("packages/modules/orders/src/actions/list.db.test.ts"),
          code: UNDECLARED_AGGREGATE,
        },
        {
          filename: file(
            "packages/modules/pricing/src/services/count-price-list-entries.ts",
          ),
          code: `
            import { priceListEntries } from "@showzy/db/schema/pricing";
            import { count } from "drizzle-orm";
            export const n = count();
          `,
        },
      ],
      invalid: [
        {
          filename: file(
            "packages/modules/orders/src/services/count-ai-revenue.ts",
          ),
          code: UNDECLARED_AGGREGATE,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
        {
          filename: `C:\\repo\\packages\\modules\\orders\\src\\services\\count-ai-revenue.ts`,
          code: UNDECLARED_AGGREGATE,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
        {
          filename: file(
            "packages/modules/documents/src/services/sum-document-gross.ts",
          ),
          code: `
            import { documents } from "@showzy/db/schema/documents";
            import { sum } from "drizzle-orm";
            export const gross = sum(documents.totalGrossMinor);
          `,
          errors: [{ messageId: "undeclaredProvenanceAggregate" }],
        },
      ],
    },
  );
  assert.ok(true);
});

test("fails on a newly added aggregate that neither consults nor is listed (temporary file)", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sho-489-"));
  const relative =
    "packages/modules/orders/src/services/sho-489-temp-revenue.ts";
  const nested = path.join(directory, ...relative.split("/"));
  mkdirSync(path.dirname(nested), { recursive: true });
  writeFileSync(nested, UNDECLARED_AGGREGATE);
  try {
    tester.run(
      "showzy/record-verification-aggregates",
      recordVerificationAggregatesRule,
      {
        valid: [],
        invalid: [
          {
            filename: nested,
            code: readFileSync(nested, "utf8"),
            errors: [{ messageId: "undeclaredProvenanceAggregate" }],
          },
        ],
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("passes for live order-list/aggregate.ts (consults) and each listed exemption", () => {
  const consulting = file(
    "packages/modules/orders/src/services/order-list/aggregate.ts",
  );
  tester.run(
    "showzy/record-verification-aggregates",
    recordVerificationAggregatesRule,
    {
      valid: [
        {
          filename: consulting,
          code: readFileSync(consulting, "utf8"),
        },
        ...Object.keys(RECORD_VERIFICATION_AGGREGATE_EXEMPTIONS).map(
          (relative) => ({
            filename: file(relative),
            code: readFileSync(file(relative), "utf8"),
          }),
        ),
      ],
      invalid: [],
    },
  );
});

/**
 * SHO-494: the rule's `PROVENANCE_TABLE_EXPORTS` is a hand-written list;
 * the ground truth is the `recordProvenanceColumns()` call sites in
 * `packages/db/src/schema/*.ts`. The derivation lives here, not in the
 * rule — lint stays a cheap import-conjunction check and the binding
 * only has to hold at CI time (the same shape as the exemption test
 * above, which reads every listed file).
 *
 * Deriving from `@showzy/core`'s contract-check instead would answer a
 * different question and would make tooling depend on core.
 */
const SCHEMA_DIRECTORY = "packages/db/src/schema";
const PROVENANCE_HELPER = "recordProvenanceColumns";
const RULE_SOURCE =
  "packages/tooling/eslint/record-verification-aggregates.mjs";

/**
 * Every node of a TS-ESTree AST, depth-first. Kept local so the binding
 * does not pull a walker dependency into `@showzy/tooling`.
 *
 * @param {unknown} value
 * @returns {Generator<Record<string, unknown>>}
 */
function* astNodes(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* astNodes(item);
    }
    return;
  }
  const node = /** @type {Record<string, unknown>} */ (value);
  if (typeof node.type !== "string") {
    return;
  }
  yield node;
  for (const key of Object.keys(node)) {
    if (key === "parent") {
      continue;
    }
    yield* astNodes(node[key]);
  }
}

/**
 * @param {Record<string, unknown>} node
 * @param {string} name
 */
function isCallTo(node, name) {
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = /** @type {Record<string, unknown>} */ (node.callee);
  return callee.type === "Identifier" && callee.name === name;
}

/**
 * Exported `const <name> = pgTable(...)` declarations in one parsed file,
 * with the source range of the `pgTable(...)` call.
 *
 * @param {Record<string, unknown>} ast
 */
function exportedTables(ast) {
  /** @type {{ name: string, range: [number, number] }[]} */
  const tables = [];
  for (const node of astNodes(ast)) {
    if (node.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = node.declaration;
    if (
      declaration === null ||
      typeof declaration !== "object" ||
      /** @type {Record<string, unknown>} */ (declaration).type !==
        "VariableDeclaration"
    ) {
      continue;
    }
    const declarators = /** @type {Record<string, unknown>[]} */ (
      /** @type {Record<string, unknown>} */ (declaration).declarations
    );
    for (const declarator of declarators) {
      const id = /** @type {Record<string, unknown>} */ (declarator.id);
      const init = declarator.init;
      if (
        id.type !== "Identifier" ||
        init === null ||
        typeof init !== "object"
      ) {
        continue;
      }
      const call = /** @type {Record<string, unknown>} */ (init);
      if (!isCallTo(call, "pgTable")) {
        continue;
      }
      tables.push({
        name: /** @type {string} */ (id.name),
        range: /** @type {[number, number]} */ (call.range),
      });
    }
  }
  return tables;
}

/**
 * Schema export names of every table whose definition spreads
 * `recordProvenanceColumns()`, mapped to the `file:line` of that call.
 * `unattributed` collects calls that sit outside an exported
 * `pgTable(...)` — the binding cannot name a table for those, and a
 * silent miss is exactly what this test exists to prevent.
 *
 * @param {string} directory absolute path to a schema directory
 */
function deriveProvenanceTableExports(directory) {
  /** @type {Map<string, string>} */
  const derived = new Map();
  /** @type {string[]} */
  const unattributed = [];
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  for (const name of names) {
    const code = readFileSync(path.join(directory, name), "utf8");
    const { ast } = tseslint.parser.parseForESLint(code, {
      ecmaVersion: 2022,
      sourceType: "module",
      range: true,
      loc: true,
    });
    const tables = exportedTables(ast);
    for (const node of astNodes(ast)) {
      if (!isCallTo(node, PROVENANCE_HELPER)) {
        continue;
      }
      const range = /** @type {[number, number]} */ (node.range);
      const loc = /** @type {{ start: { line: number } }} */ (node.loc);
      const at = `${SCHEMA_DIRECTORY}/${name}:${loc.start.line}`;
      const owner = tables.find(
        (table) => table.range[0] <= range[0] && range[1] <= table.range[1],
      );
      if (owner === undefined) {
        unattributed.push(at);
        continue;
      }
      derived.set(owner.name, at);
    }
  }
  return { derived, unattributed };
}

test("the derivation reads a tenth provenance table out of a schema fixture", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sho-494-"));
  writeFileSync(
    path.join(directory, "loyalty.ts"),
    `
      import { pgTable, text, uuid } from "drizzle-orm/pg-core";

      import { recordProvenanceColumns, timestampColumns } from "./tenant-columns.js";

      export const loyaltyCards = pgTable("loyalty_cards", {
        id: uuid("id").primaryKey().defaultRandom(),
        code: text("code").notNull(),
        ...timestampColumns(),
        ...recordProvenanceColumns(),
      });

      export const loyaltyTiers = pgTable("loyalty_tiers", {
        id: uuid("id").primaryKey().defaultRandom(),
        name: text("name").notNull(),
        ...timestampColumns(),
      });
    `,
  );
  try {
    const { derived, unattributed } = deriveProvenanceTableExports(directory);
    assert.deepEqual(unattributed, []);
    assert.deepEqual([...derived.keys()], ["loyaltyCards"]);
    assert.equal(
      derived.get("loyaltyCards"),
      `${SCHEMA_DIRECTORY}/loyalty.ts:10`,
    );
    // The tenth table is not in the rule's list — which is the failure
    // the binding test below reports against the real schema directory.
    assert.equal(PROVENANCE_TABLE_EXPORTS.has("loyaltyCards"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PROVENANCE_TABLE_EXPORTS is bound to the recordProvenanceColumns() call sites in the schema", () => {
  const { derived, unattributed } = deriveProvenanceTableExports(
    file(SCHEMA_DIRECTORY),
  );

  assert.deepEqual(
    unattributed,
    [],
    `${PROVENANCE_HELPER}() called outside an exported pgTable(...) at ${unattributed.join(", ")} — the binding cannot name a table for it. Export the table, or teach deriveProvenanceTableExports the new shape.`,
  );

  /** @type {string[]} */
  const problems = [];
  for (const [name, at] of derived) {
    if (!PROVENANCE_TABLE_EXPORTS.has(name)) {
      problems.push(
        `missing "${name}" — ${at} declares ${PROVENANCE_HELPER}(); add "${name}" to PROVENANCE_TABLE_EXPORTS in ${RULE_SOURCE}`,
      );
    }
  }
  for (const name of PROVENANCE_TABLE_EXPORTS) {
    if (!derived.has(name)) {
      problems.push(
        `extra "${name}" — no exported table in ${SCHEMA_DIRECTORY}/*.ts declares ${PROVENANCE_HELPER}() under that name; remove "${name}" from PROVENANCE_TABLE_EXPORTS in ${RULE_SOURCE}, or restore the schema export it was renamed from`,
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    `PROVENANCE_TABLE_EXPORTS has drifted from ${SCHEMA_DIRECTORY} (SHO-494):\n${problems.join("\n")}`,
  );

  assert.deepEqual(
    [...derived.keys()].sort(),
    [...PROVENANCE_TABLE_EXPORTS].sort(),
  );
});
