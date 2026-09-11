/**
 * `@showzy/api/registry` is the one subpath the worker imports to run assistant
 * turns (SHO-569). What it may pull in is decided here, from the source: no
 * relative import (so none of `http`, `auth`, `stores`, `boot`, `pipeline`,
 * `observability`), and nothing but `@showzy/core`, module barrels and a
 * type-only `zod`.
 *
 * Beyond that file, the graph is the module packages it imports. Lint enforces
 * only part of it: a module may not import `@showzy/api` or `@showzy/ai`
 * (`showzy/import-boundaries`). `@showzy/config` is a platform package modules
 * may import, so the rest is pinned below by a source scan of those modules:
 * no config, auth, HTTP, Redis, Postgres-driver or queue import, and no
 * environment read. That is a fact this subpath relies on, not a rule for
 * modules in general.
 */
import { readdirSync, readFileSync } from "node:fs";
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

  it("pulls no config, auth, HTTP, Redis, Postgres-driver or queue dependency into the worker through its modules", () => {
    const modulesRoot = join(import.meta.dirname, "../../../packages/modules");
    // Package name → source directory, read from the manifests, so the scan
    // follows whatever the registry imports rather than a second list.
    const directories = new Map(
      readdirSync(modulesRoot).map((directory) => {
        const manifest = JSON.parse(
          readFileSync(join(modulesRoot, directory, "package.json"), "utf8"),
        ) as { readonly name: string };
        return [manifest.name, join(modulesRoot, directory, "src")];
      }),
    );
    const imported = importsOf(source("registry.ts"))
      .map(({ spec }) => spec)
      .filter((spec) => MODULE_BARRELS.has(spec));
    expect(imported.length).toBe(MODULE_BARRELS.size);

    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^import\s+)["'](@showzy\/config|better-auth|hono|@hono\/[^"']+|ioredis|pg|bullmq)(?:\/[^"']*)?["']/gm;
    const findings: string[] = [];
    for (const barrel of imported) {
      const root = directories.get(barrel);
      expect({ barrel, found: root !== undefined }).toEqual({
        barrel,
        found: true,
      });
      if (root === undefined) {
        continue;
      }
      const files = readdirSync(root, { recursive: true })
        .map(String)
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
      for (const file of files) {
        const code = readFileSync(join(root, file), "utf8");
        for (const match of code.matchAll(forbidden)) {
          findings.push(
            `${barrel} (${file}) imports ${match[1] ?? ""}: the worker would load it through @showzy/api/registry`,
          );
        }
        if (code.includes("process.env")) {
          findings.push(
            `${barrel} (${file}) reads process.env: the worker would read it through @showzy/api/registry`,
          );
        }
      }
    }
    expect(findings).toEqual([]);
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
