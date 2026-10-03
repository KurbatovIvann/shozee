/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWalkSkipsLintProbes,
  TRANSIENT_LINT_PROBE_DIR,
} from "@showzy/tooling/lint-probe";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "../../..");

const MOBILE_FORM = "apps/mobile/src/features/orders/form";
const WEB_FORM = "apps/web/src/features/orders/form";

const CLASSIFY_DECL =
  /(?:export\s+)?function\s+classifyProductSellability\b|(?:export\s+)?const\s+classifyProductSellability\s*=/;

function walkTs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === TRANSIENT_LINT_PROBE_DIR
    ) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function readAppSources(
  appSrcRelative: string,
): { path: string; text: string }[] {
  return walkTs(join(repoRoot, appSrcRelative)).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
}

function consumes(
  sources: { path: string; text: string }[],
  symbol: string,
  specifier: string,
): boolean {
  const fromClause = `from "${specifier}"`;
  return sources.some(
    (file) => file.text.includes(symbol) && file.text.includes(fromClause),
  );
}

describe("repo walk and transient lint probes (SHO-863)", () => {
  it("never reads a file the web boundary suite writes and deletes", () => {
    assertWalkSkipsLintProbes(walkTs);
  });
});

describe("SHO-423 shared order-form domain (source guard)", () => {
  it("does not restore the removed app-local invariant or schema files", () => {
    expect(
      existsSync(join(repoRoot, MOBILE_FORM, "order-form.schema.ts")),
    ).toBe(false);
    expect(existsSync(join(repoRoot, WEB_FORM, "order-form.schema.ts"))).toBe(
      false,
    );
    expect(
      existsSync(join(repoRoot, MOBILE_FORM, "order-line-catalog-facts.ts")),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, WEB_FORM, "order-line-catalog-facts.ts")),
    ).toBe(false);
  });

  it("does not re-declare classifyProductSellability in either app", () => {
    const files = [
      ...readAppSources("apps/mobile/src"),
      ...readAppSources("apps/web/src"),
    ];
    const declarations = files.filter((file) => CLASSIFY_DECL.test(file.text));
    expect(
      declarations.map((file) => file.path.slice(repoRoot.length + 1)),
    ).toEqual([]);
  });

  it("both apps import sellability and the draft schema from @showzy/validation", () => {
    const mobile = readAppSources("apps/mobile/src");
    const web = readAppSources("apps/web/src");
    const facts = "@showzy/validation/order-line-catalog-facts";
    const orders = "@showzy/validation/orders";
    expect(consumes(mobile, "classifyProductSellability", facts)).toBe(true);
    expect(consumes(web, "classifyProductSellability", facts)).toBe(true);
    expect(consumes(mobile, "orderFormDraftSchema", orders)).toBe(true);
    expect(consumes(web, "orderFormDraftSchema", orders)).toBe(true);
  });

  it("keeps zod as the only runtime dependency of @showzy/validation", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages/validation/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
  });
});
