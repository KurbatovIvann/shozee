import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import {
  DRAIN_INFINITE_PAGES_ALLOWLIST,
  drainInfinitePagesBoundaryConfig,
  drainInfinitePagesImportRestriction,
} from "./drain-pages-boundary.mjs";

/**
 * @param {string} specifier
 */
function lintImport(specifier) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(`import { x } from "${specifier}";`, {
    languageOptions: { sourceType: "module", ecmaVersion: 2022 },
    rules: {
      "no-restricted-imports": ["error", drainInfinitePagesImportRestriction],
    },
  });
}

/**
 * @param {import("eslint").Linter.LintMessage[]} messages
 */
function restricted(messages) {
  return messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

describe("useDrainInfinitePages allowlist (SHO-596)", () => {
  it("flags a new call site regardless of relative depth", () => {
    expect(
      restricted(lintImport("../../../hooks/use-drain-pages")),
    ).toHaveLength(1);
    expect(restricted(lintImport("../../hooks/use-drain-pages"))).toHaveLength(
      1,
    );
  });

  it("does not flag unrelated hooks", () => {
    expect(
      restricted(lintImport("../../../hooks/use-debounced-value")),
    ).toHaveLength(0);
  });

  it("wires the restriction onto every source file except the allowlist", () => {
    expect(drainInfinitePagesBoundaryConfig.files).toEqual([
      "src/**/*.{ts,tsx}",
    ]);
    expect(drainInfinitePagesBoundaryConfig.ignores).toBe(
      DRAIN_INFINITE_PAGES_ALLOWLIST,
    );
  });

  it("pins the allowlist to the known bounded reference sets", () => {
    expect(DRAIN_INFINITE_PAGES_ALLOWLIST).toEqual([
      "src/features/customers/form/use-customer-form-lookups.ts",
      "src/features/customers/list/use-customer-lookups.ts",
      "src/features/customers/groups/use-group-form-lookups.ts",
      "src/features/customers/form/use-customer-linked-counterparties.ts",
      "src/features/documents/form/use-document-form-lookups.ts",
    ]);
  });
});
