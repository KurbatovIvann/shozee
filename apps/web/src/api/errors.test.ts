import { describe, expect, it } from "vitest";

import {
  confirmationFromError,
  describeQueryFailure,
  describeWireCode,
} from "./errors";

describe("describeQueryFailure", () => {
  it("maps a CONFLICT wire error by code, never by message text", () => {
    const error = {
      code: "CONFLICT" as const,
      status: 409,
      message: "This company address is already taken.",
    };
    expect(describeWireCode(error)).toBe("CONFLICT");
    expect(describeQueryFailure(error)).toEqual({
      kind: "conflict",
      message: "wire",
    });
  });

  it("maps CONFIRMATION_REQUIRED by code and extracts the challenge extras", () => {
    const error = {
      code: "CONFIRMATION_REQUIRED" as const,
      status: 409,
      message: "Confirm leaked secret=otp-999",
      data: {
        challenge: {
          challengeId: "challenge-1",
          summary: "Create this company",
          expiresAt: "2026-09-01T00:00:00.000Z",
          risk: "high",
        },
      },
    };
    expect(describeWireCode(error)).toBe("CONFIRMATION_REQUIRED");
    expect(describeQueryFailure(error)).toEqual({
      kind: "confirmation",
      message: "wire",
    });
    expect(confirmationFromError(error)).toEqual({
      challengeId: "challenge-1",
      summary: "Create this company",
    });
    expect(JSON.stringify(confirmationFromError(error))).not.toMatch(/otp-999/);
  });
});
