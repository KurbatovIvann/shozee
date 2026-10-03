import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

const SOURCE_ROOTS = ["packages", "apps"];
const TRANSIENT_LINT_PROBE_DIR = "__boundary-probe__";
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  TRANSIENT_LINT_PROBE_DIR,
]);

const SHARED_SOURCE = join("packages", "validation", "src", "entity-ref.ts");
const GUARD_SOURCE = relative(repoRoot, fileURLToPath(import.meta.url));

const SHARED_SPECIFIER = '"@showzy/validation/entity-ref"';

const CUSTOMER_KIND = String.raw`kind\s*\??\s*:\s*(?:z\.literal\(\s*)?["']customer["']`;
const TYPED_QUERY = String.raw`query\s*\??\s*:\s*(?:readonly\s+)?(?:string\b|z\.string\b)`;

const REDECLARED_SHAPE = [
  new RegExp(`${CUSTOMER_KIND}[^{}]*?${TYPED_QUERY}`),
  new RegExp(`${TYPED_QUERY}[^{}]*?${CUSTOMER_KIND}`),
];

function collectSources(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        collectSources(join(directory, entry.name), into);
      }
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      into.push(join(directory, entry.name));
    }
  }
}

function readRepoSources(): { path: string; text: string }[] {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    collectSources(join(repoRoot, root), files);
  }
  return files
    .map((path) => relative(repoRoot, path))
    .filter((path) => path !== SHARED_SOURCE && path !== GUARD_SOURCE)
    .map((path) => ({
      path: path.split(sep).join("/"),
      text: readFileSync(join(repoRoot, path), "utf8"),
    }));
}

const sources = readRepoSources();

describe("one entity-lookup target", () => {
  it("finds the repository sources to guard", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("declares the kinds and the schema in one place", () => {
    const shared = readFileSync(join(repoRoot, SHARED_SOURCE), "utf8");

    expect(shared).toContain("export const ENTITY_LOOKUP_KINDS");
    expect(shared).toContain("export const entityLookupTargetSchema");
  });

  it("re-declares the customer lookup target shape nowhere else", () => {
    const offenders = sources
      .filter((file) =>
        REDECLARED_SHAPE.some((pattern) => pattern.test(file.text)),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("names EntityLookupTarget only where it is imported from the shared module", () => {
    const offenders = sources
      .filter(
        (file) =>
          file.text.includes("EntityLookupTarget") &&
          !file.text.includes(SHARED_SPECIFIER),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
