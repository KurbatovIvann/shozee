import { describe, expect, it } from "vitest";

import {
  LIST_NAME_INDEX_PRICE_LISTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

describe("pricing.listNameIndex contract", () => {
  it("is a staff internal read with pricing:view", () => {
    expect(listNameIndexContract.name).toBe("pricing.listNameIndex");
    expect(listNameIndexContract.principal).toBe("staff");
    expect(listNameIndexContract.transport).toBe("internal");
    expect(listNameIndexContract.risk).toBe("read");
    expect(listNameIndexContract.permissions).toEqual(["pricing:view"]);
    expect(listNameIndexContract.aiExposure).toBe("internal");
    expect(listNameIndexContract.audit).toBe(false);
    expect(listNameIndexContract.idempotent).toBe(false);
    expect(listNameIndexContract.requiresConfirmation).toBe(false);
    expect(listNameIndexContract.emits).toEqual([]);
    expect(listNameIndexContract.timeout).toBe(5_000);
    expect(LIST_NAME_INDEX_PRICE_LISTS_MAX).toBe(1_000);
  });

  it("takes no input and rejects a tenant identifier", () => {
    expect(listNameIndexContract.input.parse({})).toEqual({});
    expect(
      listNameIndexContract.input.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });

  it("carries ids and names only", () => {
    const parsed = listNameIndexContract.output.parse({
      priceLists: {
        items: [
          { id: "11111111-1111-4111-8111-111111111111", name: "Роздріб" },
        ],
        truncated: false,
      },
    });
    expect(Object.keys(parsed.priceLists.items[0] ?? {}).sort()).toEqual([
      "id",
      "name",
    ]);
    expect(
      listNameIndexContract.output.safeParse({
        priceLists: {
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Роздріб",
              isDefault: true,
            },
          ],
          truncated: false,
        },
      }).success,
    ).toBe(false);
  });
});
