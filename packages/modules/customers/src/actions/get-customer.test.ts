import { describe, expect, it } from "vitest";

import {
  getCustomerContract,
  getCustomerInputSchema,
  getCustomerOutputSchema,
} from "./get-customer.contract.js";

const validId = "11111111-1111-4111-8111-111111111111";

describe("customers.getCustomer contract", () => {
  it("is a staff client read with customers:view", () => {
    expect(getCustomerContract.name).toBe("customers.getCustomer");
    expect(getCustomerContract.principal).toBe("staff");
    expect(getCustomerContract.transport).toBe("client");
    expect(getCustomerContract.risk).toBe("read");
    expect(getCustomerContract.permissions).toEqual(["customers:view"]);
    expect(getCustomerContract.aiExposure).toBe("exposed");
    expect(getCustomerContract.audit).toBe(false);
    expect(getCustomerContract.idempotent).toBe(false);
    expect(getCustomerContract.emits).toEqual([]);
    expect(getCustomerContract.timeout).toBe(5_000);
    expect(getCustomerContract.rateLimit).toBeUndefined();
    expect(getCustomerContract.errors.toSorted()).toEqual([
      "CONFLICT",
      "NOT_FOUND",
      "VALIDATION",
    ]);
    expect(Object.keys(getCustomerOutputSchema.shape).toSorted()).toEqual([
      "createdAt",
      "email",
      "groupId",
      "id",
      "linkedCounterpartyCount",
      "name",
      "notes",
      "phone",
      "priceListId",
      "status",
      "updatedAt",
      "userId",
    ]);
  });

  it("accepts a uuid id and rejects missing, malformed, and extra identifier fields", () => {
    expect(getCustomerInputSchema.parse({ id: validId })).toEqual({
      id: validId,
    });
    expect(getCustomerInputSchema.safeParse({}).success).toBe(false);
    expect(getCustomerInputSchema.safeParse({ id: "not-a-uuid" }).success).toBe(
      false,
    );
    for (const extra of [
      { companyId: "c" },
      { customerId: validId },
      { status: "active" },
    ]) {
      expect(
        getCustomerInputSchema.safeParse({ id: validId, ...extra }).success,
      ).toBe(false);
    }
  });

  it("accepts a human query and refuses both references at once", () => {
    expect(getCustomerInputSchema.parse({ query: " Катя Самбука " })).toEqual({
      query: "Катя Самбука",
    });
    expect(
      getCustomerInputSchema.safeParse({ id: validId, query: "Катя" }).success,
    ).toBe(false);
    expect(getCustomerInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(
      getCustomerInputSchema.safeParse({ query: "x".repeat(101) }).success,
    ).toBe(false);
  });
});
