import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  ActionContract,
  ActionContractDefinition,
} from "../contract/index.js";
import { defineActionContract } from "../contract/index.js";
import { ActionRegistry } from "../runtime/action-registry.js";
import { implementAction } from "../runtime/implement-action.js";
import { collectWritePreviewProblems } from "./write-previews.js";

const io = z.object({});

function fixtureContract(
  overrides: Partial<ActionContractDefinition> & { name: string },
): ActionContract {
  return defineActionContract({
    description: "Write-preview fixture action.",
    principal: "staff",
    transport: "client",
    input: io,
    output: io,
    permissions: ["fixture:view"],
    aiExposure: "internal",
    risk: "read",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors: [],
    audit: false,
    timeout: 5_000,
    ...overrides,
  });
}

function registryOf(
  ...entries: readonly {
    readonly contract: ActionContract;
    readonly withPreview?: boolean;
  }[]
): ActionRegistry {
  const registry = new ActionRegistry();
  for (const entry of entries) {
    registry.registerContract(entry.contract);
    registry.registerImplementation(
      implementAction(entry.contract, {
        handler: () => Promise.resolve({}),
        ...(entry.contract.audit
          ? { auditTarget: () => ({ type: "fixture", id: "1" }) }
          : {}),
        ...(entry.withPreview === true
          ? {
              preview: () => ({
                title: "Fixture card",
                lines: [{ label: "Поле", value: "значення" }],
              }),
            }
          : entry.contract.requiresConfirmation
            ? { confirmationSummary: () => "fixture summary" }
            : {}),
      }),
    );
  }
  return registry;
}

function problemsFor(registry: ActionRegistry): string[] {
  const problems: string[] = [];
  collectWritePreviewProblems(registry.implementations(), problems);
  return problems;
}

const exposedWrite = fixtureContract({
  name: "fixture.exposedWrite",
  aiExposure: "exposed",
  risk: "write",
  idempotent: true,
  audit: true,
});

const exposedHighRisk = fixtureContract({
  name: "fixture.exposedHighRisk",
  aiExposure: "exposed",
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  audit: true,
});

describe("contract check: AI-exposed writes bind a preview", () => {
  it("fails an exposed write that binds no preview", () => {
    const problems = problemsFor(registryOf({ contract: exposedWrite }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fixture.exposedWrite");
    expect(problems[0]).toContain("must bind preview");
  });

  it("fails an exposed high-risk action that binds no preview", () => {
    const problems = problemsFor(registryOf({ contract: exposedHighRisk }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fixture.exposedHighRisk");
  });

  it("passes the same actions once they bind a preview", () => {
    expect(
      problemsFor(
        registryOf(
          { contract: exposedWrite, withPreview: true },
          { contract: exposedHighRisk, withPreview: true },
        ),
      ),
    ).toEqual([]);
  });

  it("leaves exposed reads and internal writes alone", () => {
    expect(
      problemsFor(
        registryOf(
          {
            contract: fixtureContract({
              name: "fixture.exposedRead",
              aiExposure: "exposed",
            }),
          },
          {
            contract: fixtureContract({
              name: "fixture.internalWrite",
              transport: "internal",
              risk: "write",
              idempotent: true,
              audit: true,
            }),
          },
        ),
      ),
    ).toEqual([]);
  });

  it("leaves a write that is client transport but kept from models alone", () => {
    expect(
      problemsFor(
        registryOf({
          contract: fixtureContract({
            name: "fixture.hiddenWrite",
            transport: "client",
            risk: "write",
            idempotent: true,
            audit: true,
          }),
        }),
      ),
    ).toEqual([]);
  });
});
