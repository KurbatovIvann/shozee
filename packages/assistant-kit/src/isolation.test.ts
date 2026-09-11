/**
 * The one mechanical check this package keeps.
 *
 * Not a list of words to avoid — that would be knowledge about one application
 * living inside a package that must not have any. This asserts the thing a
 * stranger would also want: that the package stands alone. If it imports only
 * the model SDK and zod, there is nowhere for someone else's domain to enter.
 *
 * Everything else is held by the design rather than by a test: the set of
 * interaction kinds comes from the caller's registry, so there is no
 * vocabulary here to leak in the first place.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ALLOWED_RUNTIME_IMPORTS = new Set(["ai", "ai/test", "zod"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const IMPORT_STATEMENT =
  /^[^\S\n]*(?:import|export)\b[^\n]*?\bfrom[^\S\n]+"([^"]+)"/gm;
const SIDE_EFFECT_IMPORT = /^[^\S\n]*import[^\S\n]+"([^"]+)"/gm;

/**
 * Specifiers of real import and export statements, ignoring relative paths.
 *
 * Anchored to a statement rather than to the word "from", because prose in a
 * comment is not a dependency — an earlier version of this check reported one
 * of its own sentences.
 */
function bareSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(IMPORT_STATEMENT),
    ...source.matchAll(SIDE_EFFECT_IMPORT),
  ]
    .map((match) => match[1] ?? "")
    .filter((specifier) => !specifier.startsWith("."));
}

describe("the package stands alone", () => {
  const files = sourceFiles(import.meta.dirname);

  it("has source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("imports nothing but the model SDK, zod, the test runner and node builtins", () => {
    const offenders = files.flatMap((file) =>
      bareSpecifiers(readFileSync(file, "utf8"))
        .filter(
          (specifier) =>
            !ALLOWED_RUNTIME_IMPORTS.has(specifier) &&
            specifier !== "vitest" &&
            !specifier.startsWith("node:"),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("declares only the model SDK and zod as runtime dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "ai",
      "zod",
    ]);
  });
});
