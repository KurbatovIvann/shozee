import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BOUNDED_REFERENCE_SET_ALLOWLIST = [
  "src/features/customers/form/use-customer-form-lookups.ts",
  "src/features/customers/list/use-customer-lookups.ts",
  "src/features/customers/groups/use-group-form-lookups.ts",
  "src/features/customers/form/use-customer-linked-counterparties.ts",
  "src/features/documents/form/use-document-form-lookups.ts",
];

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const mobileRoot = join(srcRoot, "..");

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function callsUseDrainInfinitePages(filePath: string): boolean {
  if (filePath.endsWith(join("hooks", "use-drain-pages.ts"))) {
    return false;
  }
  if (filePath.endsWith(join("hooks", "use-drain-pages.test.ts"))) {
    return false;
  }
  const content = readFileSync(filePath, "utf8");
  return content.includes("useDrainInfinitePages(");
}

describe("useDrainInfinitePages callers (SHO-596)", () => {
  it("matches exactly the allowlisted bounded reference sets", () => {
    const callers = collectSourceFiles(srcRoot)
      .filter(callsUseDrainInfinitePages)
      .map((filePath) => relative(mobileRoot, filePath).replace(/\\/g, "/"))
      .sort();

    expect(callers).toEqual([...BOUNDED_REFERENCE_SET_ALLOWLIST].sort());
  });
});
