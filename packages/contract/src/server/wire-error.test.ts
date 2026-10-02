import { ORPCError } from "@orpc/server";
import {
  ConcurrentRetryError,
  ConfirmationRequiredError,
  ConflictError,
  CoreInvariantError,
  IdempotencyConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from "@showzy/core/errors";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  wireConfirmationChallengeSchema,
  wireErrorStatus,
} from "../client/wire-errors.js";
import { toWireError } from "./wire-error.js";

describe("toWireError (contract.md §4)", () => {
  it("maps ValidationError to VALIDATION 400 with issues", () => {
    const parsed = z
      .object({ note: z.string().min(3) })
      .safeParse({ note: "x" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const error = toWireError(
      new ValidationError(parsed.error.issues),
      "write",
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(wireErrorStatus.VALIDATION);
    expect(error.data).toEqual({ issues: parsed.error.issues });
  });

  it("maps PermissionDeniedError to PERMISSION_DENIED 403", () => {
    const error = toWireError(new PermissionDeniedError(), "write");
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "You do not have permission to perform this action.",
    );
  });

  it("maps NotFoundError to NOT_FOUND 404", () => {
    const error = toWireError(new NotFoundError(), "write");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("maps ConflictError to CONFLICT 409 with the domain client message", () => {
    const error = toWireError(
      new ConflictError("Order is already confirmed."),
      "write",
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Order is already confirmed.");
  });

  it("maps IdempotencyConflictError to IDEMPOTENCY_CONFLICT 409", () => {
    const error = toWireError(new IdempotencyConflictError(), "write");
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.status).toBe(409);
  });

  it("maps ConcurrentRetryError to RETRY_IN_PROGRESS 409 with retryAfterSec", () => {
    const error = toWireError(new ConcurrentRetryError(7), "write");
    expect(error.code).toBe("RETRY_IN_PROGRESS");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ retryAfterSec: 7 });
  });

  it("maps ConfirmationRequiredError to CONFIRMATION_REQUIRED 409 with the challenge", () => {
    const challenge = {
      challengeId: "c-1",
      summary: "Delete order #42?",
      expiresAt: "2026-08-18T10:05:00.000Z",
    };
    const error = toWireError(
      new ConfirmationRequiredError(challenge),
      "write",
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(error.status).toBe(409);
    expect(error.data).toEqual({ challenge: { ...challenge, risk: "write" } });
  });

  it("carries the challenged action's risk on the wire challenge", () => {
    const challenge = {
      challengeId: "c-2",
      summary: "Delete price list «Opt»?",
      expiresAt: "2026-08-18T10:05:00.000Z",
    };
    const error = toWireError(new ConfirmationRequiredError(challenge), "high");
    expect(
      wireConfirmationChallengeSchema.parse(
        (error.data as { readonly challenge: unknown }).challenge,
      ).risk,
    ).toBe("high");
  });

  it("narrows a non-confirmable risk to the most cautious confirmable one", () => {
    const challenge = {
      challengeId: "c-3",
      summary: "Delete price list «Opt»?",
      expiresAt: "2026-08-18T10:05:00.000Z",
    };
    const error = toWireError(new ConfirmationRequiredError(challenge), "read");
    expect(
      wireConfirmationChallengeSchema.parse(
        (error.data as { readonly challenge: unknown }).challenge,
      ).risk,
    ).toBe("high");
  });

  it("maps RateLimitError to RATE_LIMITED 429 with retryAfterSec", () => {
    const error = toWireError(new RateLimitError(30), "write");
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.status).toBe(429);
    expect(error.data).toEqual({ retryAfterSec: 30 });
  });

  it("maps TimeoutError to TIMEOUT 504", () => {
    const error = toWireError(new TimeoutError(), "write");
    expect(error.code).toBe("TIMEOUT");
    expect(error.status).toBe(504);
  });

  it("maps CoreInvariantError to INTERNAL 500 with no details on the wire", () => {
    const error = toWireError(
      new CoreInvariantError("tenant leak: company mismatch"),
      "write",
    );
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
    expect(error.message).toBe("Internal error.");
    expect(JSON.stringify(error.toJSON())).not.toContain("tenant leak");
  });

  it("maps an unknown throw to INTERNAL 500 with no details on the wire", () => {
    const error = toWireError(new Error("secret internal detail"), "write");
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
    expect(error.message).toBe("Internal error.");
    expect(JSON.stringify(error.toJSON())).not.toContain(
      "secret internal detail",
    );
  });
});
