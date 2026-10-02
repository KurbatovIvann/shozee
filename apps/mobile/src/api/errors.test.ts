import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import {
  ClientUnavailableError,
  describeQueryFailure,
  describeWireError,
  HttpStatusError,
  InternalInvariantError,
} from "./errors";

describe("describeWireError (contract.md §4)", () => {
  it("narrows by code, not by message text", () => {
    const sameMessage = "Something went wrong.";
    const denied: unknown = new ORPCError("PERMISSION_DENIED", {
      defined: true,
      status: 403,
      message: sameMessage,
    });
    const unauthenticated: unknown = new ORPCError("UNAUTHENTICATED", {
      defined: true,
      status: 401,
      message: sameMessage,
    });

    expect(describeWireError(denied)?.code).toBe("PERMISSION_DENIED");
    expect(describeWireError(unauthenticated)?.code).toBe("UNAUTHENTICATED");
    expect(describeWireError(denied)?.message).toBe(sameMessage);
    expect(describeWireError(unauthenticated)?.message).toBe(sameMessage);
  });

  it("surfaces typed extras for retry and confirmation", () => {
    const limited: unknown = new ORPCError("RATE_LIMITED", {
      defined: true,
      status: 429,
      message: "Too many requests. Retry later.",
      data: { retryAfterSec: 12 },
    });
    expect(describeWireError(limited)).toEqual({
      code: "RATE_LIMITED",
      message: "Too many requests. Retry later.",
      retryAfterSec: 12,
    });

    const challenge: unknown = new ORPCError("CONFIRMATION_REQUIRED", {
      defined: true,
      status: 409,
      message: "Confirmation required.",
      data: {
        challenge: {
          challengeId: "c-1",
          summary: "Delete?",
          expiresAt: "2026-08-19T00:00:00.000Z",
          risk: "high",
        },
      },
    });
    expect(describeWireError(challenge)?.challengeId).toBe("c-1");
    expect(describeWireError(challenge)?.summary).toBe("Delete?");
  });

  it("returns null for non-wire errors", () => {
    expect(describeWireError(new Error("PERMISSION_DENIED"))).toBeNull();
    expect(describeWireError("PERMISSION_DENIED")).toBeNull();
  });
});

describe("describeQueryFailure", () => {
  it("maps wire codes to kinds and keeps retry/challenge extras", () => {
    const limited: unknown = new ORPCError("RATE_LIMITED", {
      defined: true,
      status: 429,
      message: "Too many requests. Retry later.",
      data: { retryAfterSec: 12 },
    });
    expect(describeQueryFailure(limited)).toEqual({
      kind: "rate_limited",
      message: "Too many requests. Retry later.",
      retryAfterSec: 12,
    });

    const challenge: unknown = new ORPCError("CONFIRMATION_REQUIRED", {
      defined: true,
      status: 409,
      message: "Confirmation required.",
      data: {
        challenge: {
          challengeId: "c-1",
          summary: "Delete?",
          expiresAt: "2026-08-19T00:00:00.000Z",
          risk: "high",
        },
      },
    });
    expect(describeQueryFailure(challenge)).toEqual({
      kind: "confirmation",
      message: "Confirmation required.",
      challengeId: "c-1",
      summary: "Delete?",
      risk: "high",
    });
  });

  it("classifies non-wire errors as network or offline", () => {
    expect(describeQueryFailure(new TypeError("Failed to fetch")).kind).toBe(
      "network",
    );
    expect(
      describeQueryFailure(new TypeError("Failed to fetch"), {
        online: false,
      }).kind,
    ).toBe("offline");
  });

  it("classifies ClientUnavailableError and InternalInvariantError as internal", () => {
    expect(describeQueryFailure(new ClientUnavailableError())).toEqual({
      kind: "internal",
      message: "client unavailable",
    });
    expect(describeQueryFailure(new InternalInvariantError("broken"))).toEqual({
      kind: "internal",
      message: "broken",
    });
  });

  it("maps HttpStatusError by status, not as network", () => {
    expect(describeQueryFailure(new HttpStatusError(401)).kind).toBe(
      "unauthenticated",
    );
    expect(describeQueryFailure(new HttpStatusError(403)).kind).toBe(
      "permission",
    );
    expect(describeQueryFailure(new HttpStatusError(404)).kind).toBe(
      "not_found",
    );
    expect(describeQueryFailure(new HttpStatusError(429)).kind).toBe(
      "rate_limited",
    );
    expect(describeQueryFailure(new HttpStatusError(503)).kind).toBe(
      "internal",
    );
    expect(describeQueryFailure(new HttpStatusError(418)).kind).toBe("network");
  });

  it("maps a duck-typed 401 to unauthenticated, not network", () => {
    const error = {
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Authentication required.",
    };
    expect(describeQueryFailure(error)).toEqual({
      kind: "unauthenticated",
      message: "Authentication required.",
    });
  });

  it("maps duck-typed VALIDATION and CONFLICT by code, not as network", () => {
    expect(
      describeQueryFailure({
        code: "VALIDATION",
        status: 400,
        message: "Input validation failed.",
        data: { issues: [] },
      }).kind,
    ).toBe("validation");
    expect(
      describeQueryFailure({
        code: "CONFLICT",
        status: 409,
        message: "Conflict.",
      }).kind,
    ).toBe("conflict");
  });
});
