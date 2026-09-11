/**
 * SHO-336: on-disk classification of Vitest unit vs DB integration files.
 * Keep include/exclude in sync with `packages/db/vitest.db.config.ts` and
 * `packages/db/vitest.config.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const DB_PACKAGE_UNIT_RELATIVE_FILES = Object.freeze([
  "packages/db/src/testing/ci-probe.test.ts",
  "packages/db/src/testing/schema-checks.test.ts",
  "packages/db/src/ops/backup-verify.test.ts",
]);

export const DB_SUITE_INCLUDE = Object.freeze([
  "packages/**/*.db.test.ts",
  "apps/**/*.db.test.ts",
  "packages/db/src/**/*.test.ts",
]);

export const DB_SUITE_EXCLUDE = Object.freeze([
  "**/node_modules/**",
  "**/dist/**",
  ...DB_PACKAGE_UNIT_RELATIVE_FILES,
]);

const SKIP_DIR_NAMES = new Set([
  // Claude Code worktrees (.claude/worktrees/<name>) are full checkouts of
  // this repository; their copies are not this checkout's suites (ADR-0040).
  ".claude",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "wasm",
]);

const TEST_FILE_RE = /\.test\.(ts|tsx|mjs)$/;
const DB_TEST_FILE_RE = /\.db\.test\.ts$/;

/**
 * @param {string} dir
 * @param {(relativePath: string) => void} visit
 */
function walk(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = path.relative(repoRoot, full).replaceAll("\\", "/");
    visit(relativePath);
  }
}

/**
 * @param {string} relativePath
 * @returns {"unit" | "db" | null}
 */
export function classifyTestFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.startsWith("docs/") ||
    normalized.startsWith(".claude/") ||
    normalized.includes("/archive/")
  ) {
    return null;
  }
  if (!TEST_FILE_RE.test(normalized)) {
    return null;
  }
  if (DB_TEST_FILE_RE.test(normalized)) {
    return "db";
  }
  if (DB_PACKAGE_UNIT_RELATIVE_FILES.includes(normalized)) {
    return "unit";
  }
  if (
    normalized.startsWith("packages/db/") &&
    normalized.endsWith(".test.ts")
  ) {
    return "db";
  }
  return "unit";
}

/**
 * @returns {{ unit: string[], db: string[] }}
 */
export function listClassifiedTestFiles() {
  /** @type {string[]} */
  const unit = [];
  /** @type {string[]} */
  const db = [];
  walk(repoRoot, (relativePath) => {
    const kind = classifyTestFile(relativePath);
    if (kind === "unit") {
      unit.push(relativePath);
    } else if (kind === "db") {
      db.push(relativePath);
    }
  });
  unit.sort();
  db.sort();
  return { unit, db };
}
