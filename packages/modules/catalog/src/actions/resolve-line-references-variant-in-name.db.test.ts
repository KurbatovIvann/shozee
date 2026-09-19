import { randomUUID } from "node:crypto";

import { NotFoundError } from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReferenceResolutionConflictError } from "../services/reference-resolution-conflict.js";
import { productVariantSplits } from "../services/resolve-line-references.js";
import { resolveLineReferences } from "./resolve-line-references.js";

const A = kitIdentities.companies.a;
const B = kitIdentities.companies.b;
const ids = {
  macarons: randomUUID(),
  cake: randomUUID(),
  tea: randomUUID(),
  teaBlack: randomUUID(),
  latte: randomUUID(),
  foreign: randomUUID(),
};

let kit: TestKit;

beforeAll(async () => {
  kit = await createTestKit();
  const db = kit.db.runtime.db;
  await db.insert(products).values(
    [
      [ids.macarons, A, "Макаронси"],
      [ids.cake, A, "Торт бісквітний"],
      [ids.tea, A, "Чай листовий"],
      [ids.teaBlack, A, "Чай чорний"],
      [ids.latte, A, "Лате"],
      [ids.foreign, B, "Еклери"],
    ].map(([id, companyId, name]) => ({
      id: id ?? randomUUID(),
      companyId: companyId ?? A,
      name: name ?? "",
      basePriceMinor: 100n,
    })),
  );
  await db.insert(productVariants).values(
    [
      [ids.macarons, A, "Лимон", "active"],
      [ids.macarons, A, "Малина", "active"],
      [ids.macarons, A, "Лаванда", "archived"],
      [ids.cake, A, "Полуничний", "active"],
      [ids.cake, A, "Шоколадний", "active"],
      [ids.tea, A, "Чорний", "active"],
      [ids.tea, A, "Чорний з бергамотом", "active"],
      [ids.tea, A, "Зелений з жасмином", "active"],
      [ids.tea, A, "Зелений з м'ятою", "active"],
      [ids.foreign, B, "Ванільні", "active"],
    ].map(([productId, companyId, name, status]) => ({
      productId: productId ?? "",
      companyId: companyId ?? A,
      name: name ?? "",
      status: status ?? "active",
    })),
  );
});

afterAll(async () => {
  await kit.db.close();
});

const resolveOne = (value: string) =>
  kit
    .invoke(resolveLineReferences, {
      lines: [{ product: { by: "query", value } }],
    })
    .then((found) => found.lines[0]);

describe("productVariantSplits", () => {
  it("offers every cut, either part first, and nothing for one word or a long query", () => {
    expect(productVariantSplits("Торт бісквітний полуничний")).toEqual([
      { product: "Торт", variant: "бісквітний полуничний" },
      { product: "бісквітний полуничний", variant: "Торт" },
      { product: "Торт бісквітний", variant: "полуничний" },
      { product: "полуничний", variant: "Торт бісквітний" },
    ]);
    expect(productVariantSplits("макаронси")).toEqual([]);
    expect(productVariantSplits("а б в г д е")).toEqual([]);
  });
});

describe("catalog.resolveLineReferences, a product query that names its variant", () => {
  it("resolves product words followed or preceded by variant words, inflected too", async () => {
    expect(await resolveOne("макаронси лимон")).toMatchObject({
      productName: "Макаронси",
      variantName: "Лимон",
    });
    expect(await resolveOne("Лимон макаронси")).toMatchObject({
      productName: "Макаронси",
      variantName: "Лимон",
    });
    expect(await resolveOne("торт бісквітний полуничний")).toMatchObject({
      productName: "Торт бісквітний",
      variantName: "Полуничний",
    });
    expect(await resolveOne("макаронсів малина")).toMatchObject({
      productName: "Макаронси",
      variantName: "Малина",
    });
    expect(await resolveOne("чай листовий чорний")).toMatchObject({
      productName: "Чай листовий",
      variantName: "Чорний",
    });
  });

  it("resolves each such line of a mixed order and keeps the input order", async () => {
    const found = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "query", value: "Лате" } },
        { product: { by: "query", value: "макаронси малина" } },
        { product: { by: "query", value: "макаронси лимон" } },
      ],
    });
    expect(found.lines.map((line) => line.variantName)).toEqual([
      null,
      "Малина",
      "Лимон",
    ]);
  });

  it("stays not-found when the variant words are archived, unknown, ambiguous, or the product has none", async () => {
    for (const query of [
      "макаронси лаванда",
      "макаронси фісташка",
      "чай листовий зелений",
      "лате велике",
      "еклери ванільні",
    ]) {
      await expect(resolveOne(query)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("leaves a query that matches a product on its own exactly as it was", async () => {
    expect(await resolveOne("Чай чорний")).toMatchObject({
      productId: ids.teaBlack,
      variantId: null,
    });
    await expect(resolveOne("Макаронси")).rejects.toBeInstanceOf(
      ReferenceResolutionConflictError,
    );
  });

  it("does not read the product words as naming a variant when a variant is given", async () => {
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "query", value: "макаронси лимон" },
            variantSelection: {
              kind: "reference",
              ref: { by: "query", value: "Малина" },
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
