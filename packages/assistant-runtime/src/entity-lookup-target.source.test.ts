import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const TARGET_READERS = [
  "packages/module-kit/src/entity-lookup.ts",
  "packages/ai/src/choice.ts",
  "packages/assistant-runtime/src/assistant-interactions.ts",
];

const LOCAL_DECLARATION = /type\s+EntityLookupTarget\s*=\s*\{/;
const LOCAL_CUSTOMER_MEMBER =
  /kind\??\s*:\s*(?:z\.literal\(\s*)?["']customer["']/;

describe("one entity-lookup target", () => {
  for (const relative of TARGET_READERS) {
    it(`${relative} imports it instead of declaring its own`, () => {
      const text = readFileSync(join(repoRoot, relative), "utf8");

      expect(text).toContain('from "@showzy/validation/entity-ref"');
      expect(LOCAL_DECLARATION.test(text)).toBe(false);
      expect(LOCAL_CUSTOMER_MEMBER.test(text)).toBe(false);
    });
  }

  it("declares the kinds in one place", () => {
    const shared = readFileSync(
      join(repoRoot, "packages/validation/src/entity-ref.ts"),
      "utf8",
    );

    expect(shared).toContain("export const ENTITY_LOOKUP_KINDS");
    expect(shared).toContain("export const entityLookupTargetSchema");
  });
});
