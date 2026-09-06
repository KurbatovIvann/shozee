/**
 * The CI contract-check stage (core.md §2, fnd-T10 / fnd-G1 A2): walks the
 * API composition root and fails on any registry-wide violation. Define-
 * time and implement-time rules run implicitly — importing the composition
 * executes `defineActionContract` / `implementAction` for everything
 * registered, so a broken definition fails this stage before the walk
 * starts.
 *
 * Run in CI as `pnpm --filter @showzy/api contract:check`.
 */
import {
  deriveRecordProvenanceRequirements,
  runContractCheck,
} from "@showzy/core";
import { describe, expect, it } from "vitest";

import { buildContractCheckInput } from "./composition.js";

const T1_PROVENANCE_TABLES = [
  "company_customer_invites",
  "company_customers",
  "counterparties",
  "customer_groups",
  "documents",
  "orders",
  "price_lists",
  "product_variants",
  "products",
] as const;

describe("CI contract-check stage", () => {
  it("the registered surface satisfies every core.md §2 registry rule", () => {
    const result = runContractCheck(buildContractCheckInput());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("SHO-467: AI-exposed creates derive the nine T1 tables and none violate", () => {
    const input = buildContractCheckInput();
    const required = deriveRecordProvenanceRequirements(
      input.registry.contracts(),
      input.schemaTables,
    );
    const tables = [...new Set(required.map((entry) => entry.table))].sort();
    expect(tables).toEqual([...T1_PROVENANCE_TABLES]);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.includes("provenance"),
      ),
    ).toEqual([]);
  });
});
