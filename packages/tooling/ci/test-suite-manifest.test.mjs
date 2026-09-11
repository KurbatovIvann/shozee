import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseVitestListPaths } from "./assert-test-suite-collection.mjs";
import {
  DB_PACKAGE_UNIT_RELATIVE_FILES,
  classifyTestFile,
  listClassifiedTestFiles,
  repoRoot,
} from "./test-suite-files.mjs";

const forbidImport = fileURLToPath(
  new URL("./forbid-testcontainers.mjs", import.meta.url),
);

/**
 * @param {string} source
 * @param {string} name
 */
function extractVitestNamedProject(source, name) {
  const marker = new RegExp(`name:\\s*"${name}"`);
  const start = source.search(marker);
  if (start < 0) {
    return "";
  }
  const rest = source.slice(start);
  const next = rest.slice(1).search(/name:\s*"(unit|db)"/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("packages/db postgres tests that are not *.db.test.ts stay classified as db", () => {
  assert.equal(classifyTestFile("packages/db/src/foundation.test.ts"), "db");
  assert.equal(
    classifyTestFile("packages/db/src/testing/isolation-a.test.ts"),
    "db",
  );
  assert.equal(
    classifyTestFile("packages/db/src/testing/ci-probe.test.ts"),
    "unit",
  );
  assert.equal(
    classifyTestFile("packages/core/src/errors/index.test.ts"),
    "unit",
  );
  assert.equal(
    classifyTestFile("packages/core/src/testing/kit.db.test.ts"),
    "db",
  );
  assert.equal(
    classifyTestFile("packages/ai-eval/src/eval/live.eval.ts"),
    null,
  );
  assert.equal(
    classifyTestFile("packages/ai-eval/src/expectation.test.ts"),
    "unit",
  );
});

test("Claude Code worktree copies are not this checkout's test files", () => {
  assert.equal(
    classifyTestFile(
      ".claude/worktrees/sho-1/packages/core/src/errors/index.test.ts",
    ),
    null,
  );
  assert.equal(
    classifyTestFile(
      ".claude/worktrees/sho-1/packages/modules/orders/src/actions/orders.db.test.ts",
    ),
    null,
  );
});

test("on-disk classification matches vitest.db.config include/exclude", () => {
  const { unit, db } = listClassifiedTestFiles();
  assert.ok(unit.length > 0, "expected unit test files");
  assert.ok(db.length > 0, "expected db test files");
  assert.ok(
    db.some((file) => file.endsWith(".db.test.ts")),
    "expected *.db.test.ts files in the db set",
  );
  assert.ok(
    db.includes("packages/db/src/foundation.test.ts"),
    "packages/db postgres tests must not be orphaned as unit",
  );
  for (const file of DB_PACKAGE_UNIT_RELATIVE_FILES) {
    assert.ok(unit.includes(file), `missing db-package unit file ${file}`);
    assert.ok(!db.includes(file), `${file} must not be in the db suite`);
  }

  const dbConfig = fs.readFileSync(
    path.join(repoRoot, "packages/db/vitest.db.config.ts"),
    "utf8",
  );
  assert.match(dbConfig, /packages\/\*\*\/\*\.db\.test\.ts/);
  assert.match(dbConfig, /apps\/\*\*\/\*\.db\.test\.ts/);
  assert.match(dbConfig, /packages\/db\/src\/\*\*\/\*\.test\.ts/);
  for (const file of DB_PACKAGE_UNIT_RELATIVE_FILES) {
    assert.match(
      dbConfig,
      new RegExp(file.replaceAll(".", "\\.")),
      `vitest.db.config.ts must exclude ${file}`,
    );
  }
  assert.match(dbConfig, /globalSetup/);
  assert.doesNotMatch(dbConfig, /--shard/);
});

test("parseVitestListPaths keeps .tsx before .ts", () => {
  assert.deepEqual(
    parseVitestListPaths(
      "src/ui/button.test.tsx > renders\nsrc/errors/index.test.ts > codes\n",
    ),
    ["src/errors/index.test.ts", "src/ui/button.test.tsx"],
  );
});

test("Vitest unit projects do not register the Postgres global-setup", () => {
  const configPaths = [
    ...fs.globSync("**/vitest.config.ts", { cwd: repoRoot }),
    ...fs.globSync("**/vitest.config.mjs", { cwd: repoRoot }),
  ]
    .map((relative) => relative.replaceAll("\\", "/"))
    .filter((relative) => !relative.includes("node_modules"))
    .filter((relative) => relative !== "packages/db/vitest.db.config.ts");

  assert.ok(configPaths.length > 0);
  for (const relative of configPaths) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    const unitBlock = extractVitestNamedProject(source, "unit");
    if (unitBlock) {
      assert.doesNotMatch(
        unitBlock,
        /globalSetup/,
        `${relative} unit project must not start PostgreSQL`,
      );
    } else {
      assert.doesNotMatch(
        source,
        /globalSetup/,
        `${relative} has no unit project and must not start PostgreSQL`,
      );
    }
    const dbBlock = extractVitestNamedProject(source, "db");
    if (relative === "packages/db/vitest.config.ts") {
      assert.match(dbBlock, /globalSetup/);
    }
  }
});

test("a unit-only Vitest run does not load PostgreSqlContainer", () => {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@showzy/core",
      "exec",
      "vitest",
      "run",
      "--project",
      "unit",
      "src/errors/index.test.ts",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${forbidImport}`,
      },
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /must not import @testcontainers\/postgresql/);
});

test("every classified unit file lives in a package that declares test:unit", () => {
  const { unit } = listClassifiedTestFiles();
  const packageJsonPaths = fs
    .globSync("**/package.json", { cwd: repoRoot })
    .map((relative) => relative.replaceAll("\\", "/"))
    .filter((relative) => !relative.includes("node_modules"))
    .filter((relative) => relative !== "package.json")
    .filter(
      (relative) => !relative.startsWith("packages/document-signing/wasm/"),
    );

  /** @type {{ dir: string, hasTestUnit: boolean }[]} */
  const packages = [];
  for (const relative of packageJsonPaths) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, relative), "utf8"),
    );
    if (typeof manifest.scripts?.test !== "string") {
      continue;
    }
    packages.push({
      dir: path.dirname(relative).replaceAll("\\", "/"),
      hasTestUnit: typeof manifest.scripts["test:unit"] === "string",
    });
  }

  const missingScript = packages.filter((entry) => !entry.hasTestUnit);
  assert.deepEqual(
    missingScript.map((entry) => entry.dir),
    [],
    "packages with test must declare test:unit",
  );

  const dirs = packages
    .map((entry) => entry.dir)
    .sort((a, b) => b.length - a.length);
  const orphans = [];
  for (const file of unit) {
    const owner = dirs.find(
      (dir) => file === dir || file.startsWith(`${dir}/`),
    );
    if (!owner) {
      orphans.push(file);
    }
  }
  assert.deepEqual(orphans, [], "unit files outside a test:unit package");
});
