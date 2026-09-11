/**
 * `@showzy/api/registry` is the one subpath the worker imports to run assistant
 * turns (SHO-569). What it may pull in is decided here, from the source: no
 * relative import (so none of `http`, `auth`, `stores`, `boot`, `pipeline`,
 * `observability`), and nothing but `@showzy/core`, module barrels and a
 * type-only `zod`. Module barrels cannot import `@showzy/api`, `@showzy/ai` or
 * `@showzy/config` (`showzy/import-boundaries`), so that closes the graph.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildContractCheckInput } from "./composition.js";
import { createActionRegistry } from "./registry.js";

const MODULE_BARRELS = new Set([
  "@showzy/assistant",
  "@showzy/catalog",
  "@showzy/chat",
  "@showzy/companies",
  "@showzy/customers",
  "@showzy/doc-generation",
  "@showzy/doc-signing",
  "@showzy/documents",
  "@showzy/files",
  "@showzy/invites",
  "@showzy/orders",
  "@showzy/pricing",
  "@showzy/search",
]);

function source(file: string): string {
  return readFileSync(join(import.meta.dirname, file), "utf8");
}

function importsOf(code: string): { spec: string; typeOnly: boolean }[] {
  return [
    ...code.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms),
  ].map((match) => ({
    spec: match[2] ?? "",
    typeOnly: match[1] !== undefined,
  }));
}

describe("@showzy/api/registry", () => {
  it("imports only @showzy/core, module barrels and a type-only zod", () => {
    const code = source("registry.ts");
    const imports = importsOf(code);

    expect(imports.length).toBeGreaterThan(0);
    for (const { spec, typeOnly } of imports) {
      const allowed =
        spec === "@showzy/core" ||
        MODULE_BARRELS.has(spec) ||
        (spec === "zod" && typeOnly);
      expect({ spec, allowed }).toEqual({ spec, allowed: true });
    }
    // No side-effect import, no dynamic import, no environment read.
    expect(code).not.toMatch(/^import\s+"/m);
    expect(code).not.toMatch(/import\(/);
    expect(code).not.toContain("process.env");
  });

  it("exports createActionRegistry and nothing else", () => {
    expect(
      [...source("registry.ts").matchAll(/^export\s+\S+\s+(\w+)/gm)].map(
        (match) => match[1],
      ),
    ).toEqual(["createActionRegistry"]);
  });

  it("is the registry the contract check walks and the API boots", () => {
    const names = (registry: ReturnType<typeof createActionRegistry>) =>
      registry
        .contracts()
        .map((contract) => contract.name)
        .toSorted();
    expect(names(buildContractCheckInput().registry)).toEqual(
      names(createActionRegistry()),
    );
    expect(() => {
      createActionRegistry().assertPaired();
    }).not.toThrow();
    for (const file of ["composition.ts", "boot.ts"]) {
      expect(source(file)).toContain('from "./registry.js"');
      expect(source(file)).not.toMatch(/new ActionRegistry\s*\(/);
    }
  });
});
