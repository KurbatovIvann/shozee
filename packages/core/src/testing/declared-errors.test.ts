import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../contract/define-action-contract.js";
import type { ActionContractDefinition } from "../contract/types.js";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "../errors/index.js";
import {
  assertDeclaredEscapingError,
  UndeclaredActionError,
} from "./declared-errors.js";

const io = z.object({});

function fixtureContract(
  errors: ActionContractDefinition["errors"],
): ReturnType<typeof defineActionContract> {
  return defineActionContract({
    name: "declaredErrors.probe",
    description: "Fixture for declared-error enforcement.",
    principal: "staff",
    transport: "client",
    input: io,
    output: io,
    permissions: ["declaredErrors:probe"],
    aiExposure: "internal",
    risk: "read",
    requiresConfirmation: false,
    idempotent: false,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    errors,
    audit: false,
    timeout: 5_000,
  });
}

/**
 * Stands in for CustomerReferenceConflictError / ReferenceResolutionConflictError
 * / PdfGenerationRetryableError: declaring CONFLICT must not flatten subclass
 * identity.
 */
class FixtureReferenceConflictError extends ConflictError {
  readonly choices: readonly string[];

  constructor(choices: readonly string[]) {
    super("Multiple matches.");
    this.choices = choices;
  }
}

describe("assertDeclaredEscapingError", () => {
  it("fails when an undeclared NOT_FOUND escapes", () => {
    const contract = fixtureContract([]);
    const error = new NotFoundError();
    expect(() => {
      assertDeclaredEscapingError(contract, error);
    }).toThrow(UndeclaredActionError);
    try {
      assertDeclaredEscapingError(contract, error);
    } catch (caught) {
      expect(caught).toBeInstanceOf(UndeclaredActionError);
      if (!(caught instanceof UndeclaredActionError)) {
        return;
      }
      expect(caught.actionName).toBe("declaredErrors.probe");
      expect(caught.observedCode).toBe("NOT_FOUND");
      expect(caught.message).toContain("Throw site:");
      expect(caught.message).toContain("NotFoundError");
    }
  });

  it("passes when NOT_FOUND is declared", () => {
    const contract = fixtureContract(["NOT_FOUND"]);
    expect(() => {
      assertDeclaredEscapingError(contract, new NotFoundError());
    }).not.toThrow();
  });

  it("never fails a CoreInvariantError regardless of declaration", () => {
    const empty = fixtureContract([]);
    const declaredInternalIgnored = fixtureContract(["NOT_FOUND"]);
    const invariant = new CoreInvariantError("handler bug");
    expect(() => {
      assertDeclaredEscapingError(empty, invariant);
    }).not.toThrow();
    expect(() => {
      assertDeclaredEscapingError(declaredInternalIgnored, invariant);
    }).not.toThrow();
  });

  it("treats a ConflictError subclass as declared CONFLICT and keeps identity", () => {
    const contract = fixtureContract(["CONFLICT"]);
    const error = new FixtureReferenceConflictError(["acme", "apex"]);
    expect(() => {
      assertDeclaredEscapingError(contract, error);
    }).not.toThrow();
    expect(error).toBeInstanceOf(FixtureReferenceConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.choices).toEqual(["acme", "apex"]);
    expect(error.code).toBe("CONFLICT");
  });
});
