import { describe, expect, it } from "vitest";

import { companyViewSchema } from "./company-view.contract.js";
import { getCompanyContract, getCompanyInputSchema } from "./get.contract.js";

describe("companies.get contract", () => {
  it("is a staff client read with companies:view, not settings:payments", () => {
    expect(getCompanyContract.name).toBe("companies.get");
    expect(getCompanyContract.principal).toBe("staff");
    expect(getCompanyContract.transport).toBe("client");
    expect(getCompanyContract.risk).toBe("read");
    expect(getCompanyContract.permissions).toEqual(["companies:view"]);
    expect(getCompanyContract.permissions).not.toContain("settings:payments");
    expect(getCompanyContract.permissions).not.toContain("documents:view");
    expect(getCompanyContract.aiExposure).toBe("exposed");
    expect(getCompanyContract.requiresConfirmation).toBe(false);
    expect(getCompanyContract.audit).toBe(false);
    expect(getCompanyContract.idempotent).toBe(false);
    expect(getCompanyContract.emits).toEqual([]);
    expect(getCompanyContract.atomicCalls).toEqual([]);
    expect(getCompanyContract.atomicCallers).toEqual([]);
    expect(getCompanyContract.timeout).toBe(5_000);
    expect(getCompanyContract.rateLimit).toBeUndefined();
    expect(Object.keys(companyViewSchema.shape).toSorted()).toEqual([
      "id",
      "legal",
      "name",
      "prefix",
      "slug",
    ]);
  });

  it("accepts only a strict empty object — identifiers are never input", () => {
    expect(getCompanyInputSchema.parse({})).toEqual({});
    expect(getCompanyInputSchema.safeParse({ companyId: "c" }).success).toBe(
      false,
    );
    expect(getCompanyInputSchema.safeParse({ id: "c" }).success).toBe(false);
    expect(getCompanyInputSchema.safeParse({ userId: "u" }).success).toBe(
      false,
    );
    expect(getCompanyInputSchema.safeParse([]).success).toBe(false);
    expect(getCompanyInputSchema.safeParse(null).success).toBe(false);
  });
});
