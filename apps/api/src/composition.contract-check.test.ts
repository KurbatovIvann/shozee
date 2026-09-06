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
  type ActionChannel,
} from "@showzy/core";
import type { RecordCreatedVia as DbRecordCreatedVia } from "@showzy/db/schema/tenant-columns";
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import type { RecordCreatedVia as ValidationRecordCreatedVia } from "@showzy/validation/record-verification";
import { describe, expect, expectTypeOf, it } from "vitest";

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

  it("SHO-491: ActionChannel, db RecordCreatedVia, and validation RecordCreatedVia match", () => {
    expectTypeOf<ActionChannel>().toEqualTypeOf<DbRecordCreatedVia>();
    expectTypeOf<ActionChannel>().toEqualTypeOf<ValidationRecordCreatedVia>();
    expectTypeOf<DbRecordCreatedVia>().toEqualTypeOf<ValidationRecordCreatedVia>();
  });

  it("SHO-471: every registered assistant surface binding resolves (no hardcoded kinds)", () => {
    const input = buildContractCheckInput();
    expect(input.assistantSurfaces).toEqual(
      ASSISTANT_SURFACE_REGISTRY.map((surface) => ({
        kind: surface.kind,
        actionNames: surface.actionNames,
        toolNames: surface.toolNames,
      })),
    );
    expect(input.assistantSurfaces.length).toBeGreaterThan(0);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.startsWith("assistant surface "),
      ),
    ).toEqual([]);
  });
});
