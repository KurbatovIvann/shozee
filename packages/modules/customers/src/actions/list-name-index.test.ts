import { describe, expect, it } from "vitest";

import {
  LIST_NAME_INDEX_CUSTOMERS_MAX,
  LIST_NAME_INDEX_GROUPS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

describe("customers.listNameIndex contract", () => {
  it("is a staff internal read with customers:view", () => {
    expect(listNameIndexContract.name).toBe("customers.listNameIndex");
    expect(listNameIndexContract.principal).toBe("staff");
    expect(listNameIndexContract.transport).toBe("internal");
    expect(listNameIndexContract.risk).toBe("read");
    expect(listNameIndexContract.permissions).toEqual(["customers:view"]);
    expect(listNameIndexContract.aiExposure).toBe("internal");
    expect(listNameIndexContract.audit).toBe(false);
    expect(listNameIndexContract.idempotent).toBe(false);
    expect(listNameIndexContract.requiresConfirmation).toBe(false);
    expect(listNameIndexContract.emits).toEqual([]);
    expect(listNameIndexContract.timeout).toBe(5_000);
    expect(LIST_NAME_INDEX_CUSTOMERS_MAX).toBe(20_000);
    expect(LIST_NAME_INDEX_GROUPS_MAX).toBe(5_000);
  });

  it("takes no input and rejects a tenant identifier", () => {
    expect(listNameIndexContract.input.parse({})).toEqual({});
    expect(
      listNameIndexContract.input.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(listNameIndexContract.input.safeParse({ limit: 10 }).success).toBe(
      false,
    );
  });

  it("carries ids and names only, never a contact field", () => {
    const parsed = listNameIndexContract.output.parse({
      customers: {
        items: [{ id: "11111111-1111-4111-8111-111111111111", name: "Alpha" }],
        truncated: false,
      },
      groups: { items: [], truncated: false },
    });
    expect(Object.keys(parsed.customers.items[0] ?? {}).sort()).toEqual([
      "id",
      "name",
    ]);

    for (const contact of ["phone", "email"]) {
      expect(
        listNameIndexContract.output.safeParse({
          customers: {
            items: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Alpha",
                [contact]: "leaked",
              },
            ],
            truncated: false,
          },
          groups: { items: [], truncated: false },
        }).success,
      ).toBe(false);
    }
  });
});
