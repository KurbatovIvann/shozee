import { randomUUID } from "node:crypto";

import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products } from "@showzy/db/schema/catalog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReferenceResolutionConflictError } from "../services/reference-resolution-conflict.js";
import { resolveLineReferences } from "./resolve-line-references.js";

const A = kitIdentities.companies.a;
const ids = {
  croissant: randomUUID(),
  croissantChoco: randomUUID(),
  cappuccino: randomUUID(),
  cheesecake: randomUUID(),
  foreign: randomUUID(),
};

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  await kit.db.runtime.db.insert(products).values(
    [
      [ids.croissant, A, "Круасан"],
      [ids.croissantChoco, A, "Круасан з шоколадом"],
      [ids.cappuccino, A, "Капучино"],
      [ids.cheesecake, A, "Чізкейк"],
      [ids.foreign, kitIdentities.companies.b, "Наполеон"],
    ].map(([id, companyId, name]) => ({
      id: id ?? randomUUID(),
      companyId: companyId ?? A,
      name: name ?? "",
      basePriceMinor: 100n,
    })),
  );
});

afterAll(async () => {
  await kit.db.close();
});

const resolveOne = (value: string) =>
  kit.invoke(resolveLineReferences, {
    lines: [{ product: { by: "query", value } }],
  });

async function pickerIds(value: string): Promise<string[]> {
  try {
    await resolveOne(value);
  } catch (error) {
    if (error instanceof ReferenceResolutionConflictError) {
      return error.options.map((option) => option.id).toSorted();
    }
    throw error;
  }
  return ["resolved"];
}

describe("catalog.resolveLineReferences inflected and typo queries", () => {
  it("resolves a unique inflected product name, per line", async () => {
    const resolved = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "query", value: "круасана" } },
        { product: { by: "query", value: "капучино" } },
      ],
    });
    expect(resolved.lines.map((line) => line.productId)).toEqual([
      ids.croissant,
      ids.cappuccino,
    ]);
  });

  it("never auto-chooses a typo, a substring or a longer name", async () => {
    expect(await pickerIds("капучіно")).toEqual([ids.cappuccino]);
    expect(await pickerIds("кейк")).toEqual([ids.cheesecake]);
    expect(await pickerIds("круасан з")).toEqual([ids.croissantChoco]);
  });

  it("does not offer another tenant's product", async () => {
    await expect(resolveOne("наполеона")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
