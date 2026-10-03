import { describe, expect, it } from "vitest";

import {
  COUNTERPARTY_NAME_MAX,
  COUNTERPARTY_NOTES_MAX,
} from "./counterparty-view.contract.js";
import {
  updateCounterpartyContract,
  updateCounterpartyInputSchema,
  updateCounterpartyOutputSchema,
} from "./update-counterparty.contract.js";

const validUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "ТОВ Партнер",
};

describe("customers.updateCounterparty contract", () => {
  it("is an idempotent audited staff client write with customers:edit and no events", () => {
    expect(updateCounterpartyContract.name).toBe(
      "customers.updateCounterparty",
    );
    expect(updateCounterpartyContract.principal).toBe("staff");
    expect(updateCounterpartyContract.transport).toBe("client");
    expect(updateCounterpartyContract.risk).toBe("write");
    expect(updateCounterpartyContract.permissions).toEqual(["customers:edit"]);
    expect(updateCounterpartyContract.aiExposure).toBe("exposed");
    expect(updateCounterpartyContract.requiresConfirmation).toBe(false);
    expect(updateCounterpartyContract.idempotent).toBe(true);
    expect(updateCounterpartyContract.audit).toBe(true);
    expect(updateCounterpartyContract.emits).toEqual([]);
    expect(updateCounterpartyContract.atomicCalls).toEqual([]);
    expect(updateCounterpartyContract.atomicCallers).toEqual([]);
    expect(updateCounterpartyContract.timeout).toBe(5_000);
    expect(updateCounterpartyContract.rateLimit).toBeUndefined();
    expect(
      Object.keys(updateCounterpartyOutputSchema.shape).toSorted(),
    ).toEqual([
      "bankMfo",
      "bankName",
      "createdAt",
      "customerId",
      "customerName",
      "edrpou",
      "email",
      "iban",
      "id",
      "legalAddress",
      "name",
      "notes",
      "phone",
      "updatedAt",
    ]);
  });

  it("trims the name and rejects blank names, over-max fields, and bad ids", () => {
    expect(updateCounterpartyInputSchema.parse(validUpdate).name).toBe(
      "ТОВ Партнер",
    );
    expect(
      updateCounterpartyInputSchema.parse({
        ...validUpdate,
        name: "  Київські торти  ",
      }).name,
    ).toBe("Київські торти");
    expect(
      updateCounterpartyInputSchema.safeParse({
        ...validUpdate,
        name: "   ",
      }).success,
    ).toBe(false);
    expect(
      updateCounterpartyInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(COUNTERPARTY_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateCounterpartyInputSchema.safeParse({
        ...validUpdate,
        notes: "x".repeat(COUNTERPARTY_NOTES_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateCounterpartyInputSchema.safeParse({
        ...validUpdate,
        id: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      updateCounterpartyInputSchema.parse({
        ...validUpdate,
        customerId: null,
        edrpou: null,
      }),
    ).toMatchObject({
      customerId: null,
      edrpou: null,
    });
  });

  it("omits the name to keep it and refuses to clear it with null", () => {
    expect(
      updateCounterpartyInputSchema.safeParse({
        id: validUpdate.id,
        notes: "платить після відвантаження",
      }),
    ).toMatchObject({ success: true });
    expect(
      updateCounterpartyInputSchema.safeParse({ id: validUpdate.id }).success,
    ).toBe(true);
    expect(
      updateCounterpartyInputSchema.safeParse({ ...validUpdate, name: null })
        .success,
    ).toBe(false);
  });

  it("rejects identifier fields — the input is strict", () => {
    for (const extra of [
      { companyId: "c" },
      { groupId: "11111111-1111-4111-8111-111111111111" },
      { priceListId: "11111111-1111-4111-8111-111111111111" },
      { userId: "u" },
      { kind: "business" },
      { archived: true },
    ]) {
      expect(
        updateCounterpartyInputSchema.safeParse({ ...validUpdate, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
