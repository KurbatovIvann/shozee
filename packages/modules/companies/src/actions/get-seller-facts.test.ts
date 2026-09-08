import { describe, expect, it } from "vitest";

import { companyViewSchema } from "./company-view.contract.js";
import {
  getSellerFactsContract,
  getSellerFactsInputSchema,
} from "./get-seller-facts.contract.js";

describe("companies.getSellerFacts contract", () => {
  it("is a staff internal read with companies:view, not settings:payments", () => {
    expect(getSellerFactsContract.name).toBe("companies.getSellerFacts");
    expect(getSellerFactsContract.principal).toBe("staff");
    expect(getSellerFactsContract.transport).toBe("internal");
    expect(getSellerFactsContract.risk).toBe("read");
    expect(getSellerFactsContract.permissions).toEqual(["companies:view"]);
    expect(getSellerFactsContract.permissions).not.toContain(
      "settings:payments",
    );
    expect(getSellerFactsContract.permissions).not.toContain("documents:view");
    expect(getSellerFactsContract.aiExposure).toBe("internal");
    expect(getSellerFactsContract.requiresConfirmation).toBe(false);
    expect(getSellerFactsContract.audit).toBe(false);
    expect(getSellerFactsContract.idempotent).toBe(false);
    expect(getSellerFactsContract.emits).toEqual([]);
    expect(getSellerFactsContract.atomicCalls).toEqual([]);
    expect(getSellerFactsContract.atomicCallers).toEqual([]);
    expect(getSellerFactsContract.timeout).toBe(5_000);
    expect(getSellerFactsContract.rateLimit).toBeUndefined();
    expect(Object.keys(companyViewSchema.shape).toSorted()).toEqual([
      "id",
      "legal",
      "name",
      "prefix",
      "slug",
    ]);
  });

  it("accepts only a strict empty object — identifiers are never input", () => {
    expect(getSellerFactsInputSchema.parse({})).toEqual({});
    expect(
      getSellerFactsInputSchema.safeParse({ companyId: "c" }).success,
    ).toBe(false);
    expect(getSellerFactsInputSchema.safeParse({ id: "c" }).success).toBe(
      false,
    );
    expect(getSellerFactsInputSchema.safeParse({ userId: "u" }).success).toBe(
      false,
    );
    expect(getSellerFactsInputSchema.safeParse([]).success).toBe(false);
    expect(getSellerFactsInputSchema.safeParse(null).success).toBe(false);
  });
});
