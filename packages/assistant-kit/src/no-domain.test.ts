/**
 * The constraint that keeps this package small.
 *
 * The previous assistant runtime failed by absorbing domain specifics: a
 * generic pause mechanism grew a hardcoded action name, a domain input schema
 * and an enum of entity kinds, so every new ambiguous case became a change
 * inside the runtime. This test makes that regression loud on the first
 * commit rather than after nine hundred lines.
 *
 * A hit here is not a naming problem. It means a decision that belongs to a
 * tool or to the domain has moved into the protocol.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FORBIDDEN = [
  "order",
  "customer",
  "catalog",
  "product",
  "variant",
  "price",
  "pricing",
  "invoice",
  "company",
  "companies",
  "tenant",
  "sku",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

describe("no domain concepts in the kit", () => {
  const files = sourceFiles(join(import.meta.dirname));

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const word of FORBIDDEN) {
    it(`never mentions "${word}"`, () => {
      // `s?` catches plurals; the trailing boundary keeps legitimate longer
      // words ("production") from reading as a domain hit.
      const pattern = new RegExp(`\b${word}s?\b`, "i");
      const offenders = files.filter((file) =>
        pattern.test(readFileSync(file, "utf8")),
      );
      expect(offenders).toEqual([]);
    });
  }
});
