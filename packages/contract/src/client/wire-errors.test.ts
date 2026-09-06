import { ORPCError } from "@orpc/client";
import { isDeclaredErrorCode } from "@showzy/core/contract";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  isWireError,
  pipelineUniversalErrorDefinitions,
  procedureErrorDefinitions,
  wireConfirmationChallengeSchema,
  wireErrorDefinitions,
  wireErrorStatus,
  wireValidationIssueSchema,
  type WireError,
  type WireErrorCode,
} from "./wire-errors.js";

describe("contract.md §4 wire table", () => {
  it("pins wire code → HTTP status exactly (renames are spec rework)", () => {
    expect(wireErrorStatus).toEqual({
      VALIDATION: 400,
      UNAUTHENTICATED: 401,
      PERMISSION_DENIED: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      RETRY_IN_PROGRESS: 409,
      CONFIRMATION_REQUIRED: 409,
      RATE_LIMITED: 429,
      TIMEOUT: 504,
      INTERNAL: 500,
    });
  });

  it("defines an oRPC error entry per wire code with the table's status", () => {
    expect(Object.keys(wireErrorDefinitions).sort()).toEqual(
      Object.keys(wireErrorStatus).sort(),
    );
    for (const [code, definition] of Object.entries(wireErrorDefinitions)) {
      expect(definition.status).toBe(wireErrorStatus[code as WireErrorCode]);
    }
  });

  it("declares typed extras exactly where the table says", () => {
    const withData = Object.entries(wireErrorDefinitions)
      .filter(([, definition]) => "data" in definition)
      .map(([code]) => code)
      .sort();
    expect(withData).toEqual([
      "CONFIRMATION_REQUIRED",
      "RATE_LIMITED",
      "RETRY_IN_PROGRESS",
      "VALIDATION",
    ]);
  });

  it("pipeline-universal map is the §4 table minus declarable domain codes", () => {
    const expected = Object.keys(wireErrorStatus)
      .filter((code) => !isDeclaredErrorCode(code))
      .sort();
    expect(Object.keys(pipelineUniversalErrorDefinitions).sort()).toEqual(
      expected,
    );
  });

  it("empty declared set does not attach domain CONFLICT", () => {
    const map = procedureErrorDefinitions([]);
    expect("CONFLICT" in map).toBe(false);
    expect("NOT_FOUND" in map).toBe(false);
    expect("VALIDATION" in map).toBe(false);
    expect("CONFIRMATION_REQUIRED" in map).toBe(true);
    expect("IDEMPOTENCY_CONFLICT" in map).toBe(true);
  });

  it("declared CONFLICT keeps pipeline 409 codes", () => {
    const map = procedureErrorDefinitions(["CONFLICT"]);
    expect("CONFLICT" in map).toBe(true);
    expect("CONFIRMATION_REQUIRED" in map).toBe(true);
    expect("IDEMPOTENCY_CONFLICT" in map).toBe(true);
    expect("RETRY_IN_PROGRESS" in map).toBe(true);
    expect("NOT_FOUND" in map).toBe(false);
  });

  it("accepts a real Zod issue shape and passes extra fields through", () => {
    const issue = {
      code: "too_small",
      path: ["items", 0, "quantity"],
      message: "Too small: expected number to be >0",
      origin: "number",
      minimum: 0,
    };
    const parsed = wireValidationIssueSchema.parse(issue);
    expect(parsed).toEqual(issue);
  });

  it("pins the client-visible confirmation challenge fields (core.md §7)", () => {
    const challenge = {
      challengeId: "c-1",
      summary: "Delete order #42?",
      expiresAt: new Date().toISOString(),
    };
    expect(wireConfirmationChallengeSchema.parse(challenge)).toEqual(challenge);
    expect(
      wireConfirmationChallengeSchema.safeParse({
        ...challenge,
        inputHash: "leak",
      }).data,
    ).toEqual(challenge);
  });
});

describe("WireError union (contract.md §4)", () => {
  it("narrows extras by code without matching message text", () => {
    const limited: unknown = new ORPCError("RATE_LIMITED", {
      defined: true,
      status: 429,
      message: "Too many requests. Retry later.",
      data: { retryAfterSec: 12 },
    });
    expect(isWireError(limited)).toBe(true);
    if (!isWireError(limited) || limited.code !== "RATE_LIMITED") {
      expect.unreachable("expected RATE_LIMITED");
      return;
    }
    expectTypeOf(limited.data.retryAfterSec).toEqualTypeOf<number>();
    expectTypeOf(limited.status).toEqualTypeOf<429>();
    expect(limited.data.retryAfterSec).toBe(12);

    const denied: unknown = new ORPCError("PERMISSION_DENIED", {
      defined: true,
      status: 403,
      message: "You do not have permission to perform this action.",
    });
    expect(isWireError(denied)).toBe(true);
    if (!isWireError(denied) || denied.code !== "PERMISSION_DENIED") {
      expect.unreachable("expected PERMISSION_DENIED");
      return;
    }
    expectTypeOf(denied.status).toEqualTypeOf<403>();
    expect(denied.message).toBe(
      "You do not have permission to perform this action.",
    );

    const unauthenticated: unknown = new ORPCError("UNAUTHENTICATED", {
      defined: true,
      status: 401,
      message: "Authentication required.",
    });
    expect(isWireError(unauthenticated)).toBe(true);
    if (
      !isWireError(unauthenticated) ||
      unauthenticated.code !== "UNAUTHENTICATED"
    ) {
      expect.unreachable("expected UNAUTHENTICATED");
      return;
    }
    expectTypeOf(unauthenticated.status).toEqualTypeOf<401>();
  });

  it("rejects unknown codes and mismatched extras", () => {
    expect(
      isWireError(
        new ORPCError("BAD_REQUEST", {
          status: 400,
          message: "not a §4 code",
        }),
      ),
    ).toBe(false);
    expect(
      isWireError(
        new ORPCError("VALIDATION", {
          defined: true,
          status: 400,
          message: "Input validation failed.",
          data: { notIssues: true },
        }),
      ),
    ).toBe(false);
    expect(isWireError(new Error("VALIDATION"))).toBe(false);
  });

  it("accepts a 401-shaped error that is not instanceof ORPCError", () => {
    const foreign = {
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Authentication required.",
    };
    expect(foreign instanceof ORPCError).toBe(false);
    expect(isWireError(foreign)).toBe(true);
    if (!isWireError(foreign) || foreign.code !== "UNAUTHENTICATED") {
      expect.unreachable("expected duck-typed UNAUTHENTICATED");
      return;
    }
    expect(foreign.status).toBe(401);
  });

  it("rejects a 401 that is not a §4 code (oRPC UNAUTHORIZED)", () => {
    expect(
      isWireError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Unauthorized",
      }),
    ).toBe(false);
  });

  it("the union is exhaustive over the §4 table", () => {
    const label = (error: WireError): string => {
      switch (error.code) {
        case "VALIDATION":
          return error.data.issues[0]?.message ?? error.message;
        case "UNAUTHENTICATED":
          return "unauthenticated";
        case "PERMISSION_DENIED":
          return "denied";
        case "NOT_FOUND":
          return "missing";
        case "CONFLICT":
          return "conflict";
        case "IDEMPOTENCY_CONFLICT":
          return "idempotency";
        case "RETRY_IN_PROGRESS":
          return String(error.data.retryAfterSec);
        case "CONFIRMATION_REQUIRED":
          return error.data.challenge.challengeId;
        case "RATE_LIMITED":
          return String(error.data.retryAfterSec);
        case "TIMEOUT":
          return "timeout";
        case "INTERNAL":
          return "internal";
      }
    };

    const found = new ORPCError("NOT_FOUND", {
      defined: true,
      status: 404,
      message: "The requested resource was not found.",
    });
    expect(isWireError(found)).toBe(true);
    if (isWireError(found)) {
      expect(label(found)).toBe("missing");
    }
  });
});
