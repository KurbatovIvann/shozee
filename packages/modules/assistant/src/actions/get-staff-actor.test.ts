import { describe, expect, it } from "vitest";

import {
  getStaffActorContract,
  getStaffActorInputSchema,
  getStaffActorOutputSchema,
} from "./get-staff-actor.contract.js";

describe("assistant.getStaffActor contract", () => {
  it("is a staff internal read with assistant:use, AI-internal, and no audit", () => {
    expect(getStaffActorContract.name).toBe("assistant.getStaffActor");
    expect(getStaffActorContract.principal).toBe("staff");
    expect(getStaffActorContract.transport).toBe("internal");
    expect(getStaffActorContract.risk).toBe("read");
    expect(getStaffActorContract.permissions).toEqual(["assistant:use"]);
    expect(getStaffActorContract.aiExposure).toBe("internal");
    expect(getStaffActorContract.audit).toBe(false);
    expect(getStaffActorContract.idempotent).toBe(false);
    expect(getStaffActorContract.emits).toEqual([]);
    expect(getStaffActorContract.timeout).toBe(5_000);
  });

  it("takes empty input and returns the verified company, role and stored permissions", () => {
    expect(Object.keys(getStaffActorInputSchema.shape)).toEqual([]);
    expect(Object.keys(getStaffActorOutputSchema.shape).toSorted()).toEqual([
      "companyId",
      "permissions",
      "role",
    ]);
    // The company is an answer, never a question: input still refuses it.
    expect(
      getStaffActorInputSchema.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      getStaffActorOutputSchema.parse({
        companyId: "11111111-1111-4111-8111-111111111111",
        role: "owner",
        permissions: [],
      }),
    ).toEqual({
      companyId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      permissions: [],
    });
  });
});
