import { randomUUID } from "node:crypto";

import { type ImplementedAction } from "@showzy/core";
import {
  ConfirmationRequiredError,
  NotFoundError,
  ValidationError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type IsolationActor,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { activatePriceList } from "./activate-price-list.js";
import { createPriceList } from "./create-price-list.js";
import { deactivatePriceList } from "./deactivate-price-list.js";
import { deletePriceList } from "./delete-price-list.js";
import { removePriceListEntries } from "./remove-price-list-entries.js";
import { setDefaultPriceList } from "./set-default-price-list.js";
import { setPriceListEntries } from "./set-price-list-entries.js";
import { updatePriceList } from "./update-price-list.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  listDefault: randomUUID(),
  listIdle: randomUUID(),
  listDelete: randomUUID(),
  listB: randomUUID(),
  productA: randomUUID(),
  variantA: randomUUID(),
  productB: randomUUID(),
  missingId: randomUUID(),
};

const managerOnlyPricing = randomUUID();

let kit: TestKit;

async function invokeForCard<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
  actor: IsolationActor = {},
) {
  return await kit
    .invoke(action, input, actor, { request: { requireConfirmation: true } })
    .then(
      () => {
        throw new Error("expected the invocation to stop on a card");
      },
      (thrown: unknown) => thrown,
    );
}

async function previewOf<TInput extends z.ZodType, TOutput extends z.ZodType>(
  action: ImplementedAction<TInput, TOutput>,
  input: unknown,
  actor: IsolationActor = {},
): Promise<ActionPreview> {
  const error = await invokeForCard(action, input, actor);
  if (!(error instanceof ConfirmationRequiredError)) {
    throw error;
  }
  const preview = error.challenge.preview;
  if (preview === undefined) {
    throw new Error("expected a structured preview card");
  }
  expect(error.challenge.summary).toBe(preview.title);
  return preview;
}

function expectSameRefusal(foreign: unknown, missing: unknown): void {
  if (
    !(foreign instanceof NotFoundError) ||
    !(missing instanceof NotFoundError)
  ) {
    throw foreign;
  }
  expect(foreign.code).toBe(missing.code);
  expect(foreign.clientMessage).toBe(missing.clientMessage);
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(user).values({
    id: managerOnlyPricing,
    name: "Pricer",
    email: "pricer@pricing-previews.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: managerOnlyPricing,
    role: "employee",
    permissions: { granted: ["pricing:manage"], denied: [] },
  });

  await kit.db.runtime.db.insert(priceLists).values([
    {
      id: fixtures.listDefault,
      companyId: companyA,
      name: "Основний прайс",
      isDefault: true,
      isActive: true,
    },
    {
      id: fixtures.listIdle,
      companyId: companyA,
      name: "Гуртовий прайс",
      isDefault: false,
      isActive: false,
    },
    {
      id: fixtures.listDelete,
      companyId: companyA,
      name: "Застарілий прайс",
      isDefault: false,
      isActive: true,
    },
    { id: fixtures.listB, companyId: companyB, name: "Чужий прайс" },
  ]);

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: companyA,
      name: "Кава Арабіка",
      basePriceMinor: 15000n,
    },
    {
      id: fixtures.productB,
      companyId: companyB,
      name: "Чужий товар",
      basePriceMinor: 100n,
    },
  ]);
  await kit.db.runtime.db.insert(productVariants).values({
    id: fixtures.variantA,
    companyId: companyA,
    productId: fixtures.productA,
    name: "1 кг",
  });

  await kit.db.runtime.db.insert(priceListEntries).values([
    {
      companyId: companyA,
      priceListId: fixtures.listDefault,
      productId: fixtures.productA,
      priceMinor: 12000n,
      currency: "UAH",
    },
    {
      companyId: companyA,
      priceListId: fixtures.listDelete,
      productId: fixtures.productA,
      priceMinor: 11000n,
      currency: "UAH",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("pricing preview cards", () => {
  it("cards every field pricing.createPriceList writes", async () => {
    const preview = await previewOf(createPriceList, { name: "Роздріб" });
    expect(preview.title).toBe("Новий прайс-лист: Роздріб");
    expect(preview.lines).toEqual([
      { label: "Назва", value: "Роздріб" },
      { label: "Основний", value: "ні" },
      { label: "Активний", value: "так" },
    ]);
  });

  it("names the default it unsets, and the activation creating it implies", async () => {
    const preview = await previewOf(createPriceList, {
      name: "Новий основний",
      isDefault: true,
      isActive: false,
    });
    expect(preview.lines.slice(1)).toEqual([
      { label: "Основний", value: "Основний прайс → Новий основний" },
      { label: "Активний", value: "так" },
    ]);
  });

  it("names only the new default when the company has none yet", async () => {
    const preview = await previewOf(
      createPriceList,
      { name: "Перший основний", isDefault: true },
      {
        userId: kitIdentities.users.boris,
        companyId: companyB,
      },
    );
    expect(preview.lines.slice(1, 2)).toEqual([
      { label: "Основний", value: "Перший основний" },
    ]);
  });

  it("refuses deactivating the default on the card exactly as the write does", async () => {
    const carded = await invokeForCard(deactivatePriceList, {
      id: fixtures.listDefault,
    });
    const executed = await kit
      .invoke(deactivatePriceList, { id: fixtures.listDefault })
      .then(
        () => {
          throw new Error("expected the write to refuse the default list");
        },
        (thrown: unknown) => thrown,
      );
    if (
      !(carded instanceof ValidationError) ||
      !(executed instanceof ValidationError)
    ) {
      throw carded;
    }
    expect(carded.code).toBe(executed.code);
    expect(carded.clientMessage).toBe(executed.clientMessage);
  });

  it("still cards the deactivation of a list that is not the default", async () => {
    const preview = await previewOf(deactivatePriceList, {
      id: fixtures.listDelete,
    });
    expect(preview.title).toBe("Деактивувати прайс-лист: Застарілий прайс");
    expect(preview.lines).toEqual([{ label: "Активний", value: "так → ні" }]);
  });

  it("cards the stored-to-new name for pricing.updatePriceList", async () => {
    const preview = await previewOf(updatePriceList, {
      id: fixtures.listIdle,
      name: "Гурт +",
    });
    expect(preview.title).toBe("Змінити прайс-лист: Гуртовий прайс");
    expect(preview.lines).toEqual([
      { label: "Назва", value: "Гуртовий прайс → Гурт +" },
    ]);
  });

  it("cards the active flag for pricing.activatePriceList", async () => {
    const preview = await previewOf(activatePriceList, {
      id: fixtures.listIdle,
    });
    expect(preview.title).toBe("Активувати прайс-лист: Гуртовий прайс");
    expect(preview.lines).toEqual([{ label: "Активний", value: "ні → так" }]);
  });

  it("names both the old and the new default, and the activation it implies", async () => {
    const preview = await previewOf(setDefaultPriceList, {
      priceListId: fixtures.listIdle,
    });
    expect(preview.title).toBe("Основний прайс-лист: Гуртовий прайс");
    expect(preview.lines).toEqual([
      { label: "Основний", value: "Основний прайс → Гуртовий прайс" },
      { label: "Активний", value: "ні → так" },
    ]);
  });

  it("cards clearing the default", async () => {
    const preview = await previewOf(setDefaultPriceList, {
      priceListId: null,
    });
    expect(preview.title).toBe("Прибрати основний прайс-лист");
    expect(preview.lines).toEqual([
      { label: "Основний", value: "Основний прайс → не задано" },
    ]);
  });

  it("names the list and the inheritance consequence on the delete card", async () => {
    const preview = await previewOf(deletePriceList, {
      id: fixtures.listDelete,
    });
    expect(preview.title).toBe("Видалити прайс-лист: Застарілий прайс");
    expect(preview.lines).toEqual([
      { label: "Основний", value: "ні" },
      { label: "Активний", value: "так" },
      { label: "Цін у списку", value: "1" },
    ]);
    expect(preview.notes?.[0]).toContain("перейдуть на наступний рівень цін");
  });

  it("names each product and variant priced by pricing.setPriceListEntries", async () => {
    const preview = await previewOf(setPriceListEntries, {
      priceListId: fixtures.listDefault,
      entries: [
        { productId: fixtures.productA, priceMinor: "13000" },
        {
          productId: fixtures.productA,
          variantId: fixtures.variantA,
          priceMinor: "45000",
        },
      ],
    });
    expect(preview.title).toBe("Змінити ціни в прайс-листі: Основний прайс");
    expect(preview.lines).toEqual([
      { label: "Кава Арабіка", value: "120,00 грн → 130,00 грн" },
      { label: "Кава Арабіка / 1 кг", value: "450,00 грн" },
    ]);
  });

  it("cards only the prices pricing.removePriceListEntries actually removes", async () => {
    const preview = await previewOf(removePriceListEntries, {
      priceListId: fixtures.listDefault,
      entries: [
        { productId: fixtures.productA },
        { productId: fixtures.productA, variantId: fixtures.variantA },
      ],
    });
    expect(preview.title).toBe("Видалити ціни з прайс-листа: Основний прайс");
    expect(preview.lines).toEqual([
      { label: "Кава Арабіка", value: "120,00 грн" },
    ]);
  });

  it("names the products for a pricing:manage-only member", async () => {
    const preview = await previewOf(
      removePriceListEntries,
      {
        priceListId: fixtures.listDefault,
        entries: [{ productId: fixtures.productA }],
      },
      { userId: managerOnlyPricing, companyId: companyA },
    );
    expect(preview.lines).toEqual([
      { label: "Кава Арабіка", value: "120,00 грн" },
    ]);
  });

  it("says so when nothing on the list matches the removal", async () => {
    const preview = await previewOf(removePriceListEntries, {
      priceListId: fixtures.listIdle,
      entries: [{ productId: fixtures.productA }],
    });
    expect(preview.lines).toEqual([
      { label: "Ціни", value: "нічого не знайдено" },
    ]);
  });

  it("leaves the stored rows untouched while the cards are issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ name: priceLists.name, isDefault: priceLists.isDefault })
      .from(priceLists)
      .where(eq(priceLists.id, fixtures.listDefault));
    expect(rows[0]).toEqual({ name: "Основний прайс", isDefault: true });
  });

  it("refuses a foreign price list exactly like a missing one", async () => {
    const foreign = await invokeForCard(deletePriceList, {
      id: fixtures.listB,
    });
    expectSameRefusal(
      foreign,
      await invokeForCard(deletePriceList, { id: fixtures.missingId }),
    );
    expect(JSON.stringify(foreign)).not.toContain("Чужий прайс");
  });

  it("refuses a foreign product in the entries card exactly like a missing one", async () => {
    expectSameRefusal(
      await invokeForCard(setPriceListEntries, {
        priceListId: fixtures.listDefault,
        entries: [{ productId: fixtures.productB, priceMinor: "100" }],
      }),
      await invokeForCard(setPriceListEntries, {
        priceListId: fixtures.listDefault,
        entries: [{ productId: fixtures.missingId, priceMinor: "100" }],
      }),
    );
  });
});
