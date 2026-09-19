import { describe, expect, it } from "vitest";

import {
  CUSTOMER_NAME_MAX,
  customerViewSchema,
} from "./customer-view.contract.js";
import {
  updateCustomerContract,
  updateCustomerInputSchema,
} from "./update-customer.contract.js";

const validUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Cake",
  phone: "+380501112233",
};

describe("customers.updateCustomer contract", () => {
  it("is an idempotent audited staff client write with customers:edit and no events", () => {
    expect(updateCustomerContract.name).toBe("customers.updateCustomer");
    expect(updateCustomerContract.principal).toBe("staff");
    expect(updateCustomerContract.transport).toBe("client");
    expect(updateCustomerContract.risk).toBe("write");
    expect(updateCustomerContract.permissions).toEqual(["customers:edit"]);
    expect(updateCustomerContract.aiExposure).toBe("exposed");
    expect(updateCustomerContract.requiresConfirmation).toBe(false);
    expect(updateCustomerContract.idempotent).toBe(true);
    expect(updateCustomerContract.audit).toBe(true);
    expect(updateCustomerContract.emits).toEqual([]);
    expect(updateCustomerContract.atomicCalls).toEqual([]);
    expect(updateCustomerContract.atomicCallers).toEqual([]);
    expect(updateCustomerContract.timeout).toBe(10_000);
    expect(updateCustomerContract.rateLimit).toBeUndefined();
    expect(Object.keys(customerViewSchema.shape).toSorted()).toEqual([
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

  it("trims the name, accepts omitted contacts, and rejects blank names and bad ids", () => {
    expect(
      updateCustomerInputSchema.parse({
        ...validUpdate,
        name: "  Київ  ",
      }).name,
    ).toBe("Київ");
    expect(
      updateCustomerInputSchema.safeParse({
        ...validUpdate,
        name: "   ",
      }).success,
    ).toBe(false);
    expect(
      updateCustomerInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(CUSTOMER_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateCustomerInputSchema.safeParse({
        id: validUpdate.id,
        name: "Contacts omitted, so the stored ones stand",
      }).success,
    ).toBe(true);
    expect(
      updateCustomerInputSchema.safeParse({
        ...validUpdate,
        id: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects identifier extras — the input is strict", () => {
    for (const extra of [
      { companyId: "c" },
      { status: "archived" },
      { linkedCounterpartyCount: 1 },
    ]) {
      expect(
        updateCustomerInputSchema.safeParse({ ...validUpdate, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
