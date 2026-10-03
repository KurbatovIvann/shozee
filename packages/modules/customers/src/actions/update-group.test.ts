import { describe, expect, it } from "vitest";

import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
} from "./group-view.contract.js";
import {
  updateGroupContract,
  updateGroupInputSchema,
  updateGroupOutputSchema,
} from "./update-group.contract.js";

const validUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "VIP",
};

describe("customers.updateGroup contract", () => {
  it("is an idempotent audited staff client write with customers:edit and no events", () => {
    expect(updateGroupContract.name).toBe("customers.updateGroup");
    expect(updateGroupContract.principal).toBe("staff");
    expect(updateGroupContract.transport).toBe("client");
    expect(updateGroupContract.risk).toBe("write");
    expect(updateGroupContract.permissions).toEqual(["customers:edit"]);
    expect(updateGroupContract.aiExposure).toBe("exposed");
    expect(updateGroupContract.requiresConfirmation).toBe(false);
    expect(updateGroupContract.idempotent).toBe(true);
    expect(updateGroupContract.audit).toBe(true);
    expect(updateGroupContract.emits).toEqual([]);
    expect(updateGroupContract.atomicCalls).toEqual([]);
    expect(updateGroupContract.atomicCallers).toEqual([]);
    expect(updateGroupContract.timeout).toBe(5_000);
    expect(updateGroupContract.rateLimit).toBeUndefined();
    expect(Object.keys(updateGroupOutputSchema.shape).toSorted()).toEqual([
      "createdAt",
      "description",
      "id",
      "memberCount",
      "name",
      "priceListId",
      "slug",
      "updatedAt",
    ]);
  });

  it("trims the name and rejects blank names, over-max fields, and bad ids", () => {
    expect(updateGroupInputSchema.parse(validUpdate).name).toBe("VIP");
    expect(
      updateGroupInputSchema.parse({
        ...validUpdate,
        name: "  Київські торти  ",
      }).name,
    ).toBe("Київські торти");
    expect(
      updateGroupInputSchema.safeParse({ ...validUpdate, name: "   " }).success,
    ).toBe(false);
    expect(
      updateGroupInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(GROUP_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateGroupInputSchema.safeParse({
        ...validUpdate,
        description: "x".repeat(GROUP_DESCRIPTION_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateGroupInputSchema.safeParse({
        ...validUpdate,
        id: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      updateGroupInputSchema.parse({
        ...validUpdate,
        priceListId: null,
      }).priceListId,
    ).toBeNull();
  });

  it("omits the name to keep it and refuses to clear it with null", () => {
    expect(
      updateGroupInputSchema.safeParse({
        id: validUpdate.id,
        description: "оптовики",
      }),
    ).toMatchObject({ success: true });
    expect(
      updateGroupInputSchema.safeParse({ id: validUpdate.id }).success,
    ).toBe(true);
    expect(
      updateGroupInputSchema.safeParse({ ...validUpdate, name: null }).success,
    ).toBe(false);
  });

  it("rejects identifier fields — the input is strict and slug is server-only", () => {
    for (const extra of [
      { companyId: "c" },
      { slug: "vip" },
      { sortOrder: 1 },
      { color: "#fff" },
      { userId: "u" },
    ]) {
      expect(
        updateGroupInputSchema.safeParse({ ...validUpdate, ...extra }).success,
      ).toBe(false);
    }
  });
});
