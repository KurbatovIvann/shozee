/**
 * invokeAction is the choke point that enforces declared error codes
 * (SHO-485). These tests drive the real pipeline so the original throw
 * identity is the object tests catch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../contract/define-action-contract.js";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "../errors/index.js";
import { implementAction } from "../runtime/implement-action.js";
import {
  declaredErrorsReportPath,
  UndeclaredActionError,
} from "./declared-errors.js";
import { createTestKit, invokeAction, type TestKit } from "./kit.js";

const io = z.object({});

const defaults = {
  description: "Declared-error invokeAction fixture.",
  principal: "staff" as const,
  transport: "client" as const,
  input: io,
  output: io,
  permissions: ["declaredErrors:probe"],
  aiExposure: "internal" as const,
  risk: "read" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  errors: [],
  audit: false,
  timeout: 5_000,
};

class FixtureReferenceConflictError extends ConflictError {
  readonly choices: readonly string[];

  constructor(choices: readonly string[]) {
    super("Multiple matches.");
    this.choices = choices;
  }
}

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
});

afterAll(async () => {
  await kit.db.close();
});

describe("invokeAction declared-error enforcement", () => {
  it.skipIf(declaredErrorsReportPath() !== undefined)(
    "fails when the handler throws an undeclared NOT_FOUND",
    async () => {
      const action = implementAction(
        defineActionContract({
          ...defaults,
          name: "declaredErrors.missingNotFound",
          errors: [],
        }),
        {
          handler: () => {
            throw new NotFoundError();
          },
        },
      );
      await expect(invokeAction(kit, action, {})).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof UndeclaredActionError &&
          error.actionName === "declaredErrors.missingNotFound" &&
          error.observedCode === "NOT_FOUND" &&
          error.message.includes("Throw site:"),
      );
    },
  );

  it("propagates a declared NOT_FOUND", async () => {
    const action = implementAction(
      defineActionContract({
        ...defaults,
        name: "declaredErrors.declaredNotFound",
        errors: ["NOT_FOUND"],
      }),
      {
        handler: () => {
          throw new NotFoundError();
        },
      },
    );
    await expect(invokeAction(kit, action, {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("never fails a CoreInvariantError regardless of declaration", async () => {
    const action = implementAction(
      defineActionContract({
        ...defaults,
        name: "declaredErrors.invariant",
        errors: [],
      }),
      {
        handler: () => {
          throw new CoreInvariantError("handler bug");
        },
      },
    );
    await expect(invokeAction(kit, action, {})).rejects.toBeInstanceOf(
      CoreInvariantError,
    );
  });

  it("propagates a ConflictError subclass with identity intact", async () => {
    const action = implementAction(
      defineActionContract({
        ...defaults,
        name: "declaredErrors.conflictSubclass",
        errors: ["CONFLICT"],
      }),
      {
        handler: () => {
          throw new FixtureReferenceConflictError(["acme", "apex"]);
        },
      },
    );
    const error = await invokeAction(kit, action, {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FixtureReferenceConflictError);
    expect(error).toBeInstanceOf(ConflictError);
    if (!(error instanceof FixtureReferenceConflictError)) {
      return;
    }
    expect(error.choices).toEqual(["acme", "apex"]);
    expect(error.code).toBe("CONFLICT");
  });
});
