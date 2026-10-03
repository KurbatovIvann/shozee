import { randomUUID } from "node:crypto";

import { type ImplementedAction } from "@showzy/core";
import {
  ConfirmationRequiredError,
  NotFoundError,
  type ActionPreview,
} from "@showzy/core/errors";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { products, productVariants } from "@showzy/db/schema/catalog";
import {
  PREVIEW_CHANGES_LABEL,
  PREVIEW_NO_CHANGES,
} from "@showzy/module-kit/preview-changes";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";

import { archiveProduct } from "./archive-product.js";
import { archiveVariant } from "./archive-variant.js";
import { createProduct } from "./create-product.js";
import { createVariant } from "./create-variant.js";
import { restoreVariant } from "./restore-variant.js";
import { updateProduct } from "./update-product.js";
import { updateVariant } from "./update-variant.js";

const companyA = kitIdentities.companies.a;
const companyB = kitIdentities.companies.b;

const fixtures = {
  productA: randomUUID(),
  productB: randomUUID(),
  variantPriced: randomUUID(),
  variantInherits: randomUUID(),
  variantArchived: randomUUID(),
  variantB: randomUUID(),
  missingId: randomUUID(),
};

let kit: TestKit;

async function invokeForCard<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(action: ImplementedAction<TInput, TOutput>, input: unknown) {
  return await kit
    .invoke(action, input, {}, { request: { requireConfirmation: true } })
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
): Promise<ActionPreview> {
  const error = await invokeForCard(action, input);
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

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productA,
      companyId: companyA,
      name: "Кава Арабіка",
      basePriceMinor: 15000n,
      currency: "UAH",
    },
    {
      id: fixtures.productB,
      companyId: companyB,
      name: "Чужий товар",
      basePriceMinor: 9900n,
      currency: "UAH",
    },
  ]);
  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variantPriced,
      companyId: companyA,
      productId: fixtures.productA,
      name: "1 кг",
      basePriceMinor: 48000n,
      currency: "UAH",
    },
    {
      id: fixtures.variantInherits,
      companyId: companyA,
      productId: fixtures.productA,
      name: "250 г",
    },
    {
      id: fixtures.variantArchived,
      companyId: companyA,
      productId: fixtures.productA,
      name: "Стара фасовка",
      status: "archived",
    },
    {
      id: fixtures.variantB,
      companyId: companyB,
      productId: fixtures.productB,
      name: "Чужий варіант",
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

describe("catalog preview cards", () => {
  it("cards every field catalog.createProduct writes, variants included", async () => {
    const preview = await previewOf(createProduct, {
      name: "Чай Пуер",
      basePriceMinor: "24050",
      variants: [
        { name: "100 г" },
        { name: "500 г", basePriceMinor: "99000", currency: "UAH" },
      ],
    });
    expect(preview.title).toBe("Новий товар: Чай Пуер");
    expect(preview.lines).toEqual([
      { label: "Назва", value: "Чай Пуер" },
      { label: "Базова ціна", value: "240,50 грн" },
      { label: "Варіант: 100 г", value: "за базовою ціною товару" },
      { label: "Варіант: 500 г", value: "990,00 грн" },
    ]);
  });

  it("cards the stored-to-new change for catalog.updateProduct", async () => {
    const preview = await previewOf(updateProduct, {
      productId: fixtures.productA,
      name: "Кава Арабіка Преміум",
      basePriceMinor: "18000",
      currency: "UAH",
    });
    expect(preview.title).toBe("Змінити товар: Кава Арабіка");
    expect(preview.lines).toEqual([
      { label: "Назва", value: "Кава Арабіка → Кава Арабіка Преміум" },
      { label: "Базова ціна", value: "150,00 грн → 180,00 грн" },
    ]);
  });

  it("shows no name line when the product update names no name", async () => {
    const preview = await previewOf(updateProduct, {
      productId: fixtures.productA,
      basePriceMinor: "18000",
      currency: "UAH",
    });
    expect(preview.title).toBe("Змінити товар: Кава Арабіка");
    expect(preview.lines).toEqual([
      { label: "Базова ціна", value: "150,00 грн → 180,00 грн" },
    ]);
  });

  it("cards no changes when the product update names nothing", async () => {
    const preview = await previewOf(updateProduct, {
      productId: fixtures.productA,
    });
    expect(preview.title).toBe("Змінити товар: Кава Арабіка");
    expect(preview.lines).toEqual([
      { label: PREVIEW_CHANGES_LABEL, value: PREVIEW_NO_CHANGES },
    ]);
  });

  it("names the parent product on the catalog.createVariant card", async () => {
    const preview = await previewOf(createVariant, {
      productId: fixtures.productA,
      name: "2 кг",
    });
    expect(preview.title).toBe("Новий варіант: 2 кг");
    expect(preview.lines).toEqual([
      { label: "Товар", value: "Кава Арабіка" },
      { label: "Назва", value: "2 кг" },
      { label: "Ціна", value: "за базовою ціною товару" },
    ]);
  });

  it("cards a cleared variant override as inheriting the base price", async () => {
    const preview = await previewOf(updateVariant, {
      productId: fixtures.productA,
      variantId: fixtures.variantPriced,
      name: "1 кг",
      basePriceMinor: null,
      currency: null,
    });
    expect(preview.lines).toEqual([
      { label: "Товар", value: "Кава Арабіка" },
      { label: "Назва", value: "1 кг" },
      { label: "Ціна", value: "480,00 грн → за базовою ціною товару" },
    ]);
  });

  it("leaves the price off the card when the update omits it", async () => {
    const preview = await previewOf(updateVariant, {
      productId: fixtures.productA,
      variantId: fixtures.variantInherits,
      name: "250 грамів",
    });
    expect(preview.lines).toEqual([
      { label: "Товар", value: "Кава Арабіка" },
      { label: "Назва", value: "250 г → 250 грамів" },
    ]);
  });

  it("cards the parent product and no changes when the variant update names nothing", async () => {
    const preview = await previewOf(updateVariant, {
      productId: fixtures.productA,
      variantId: fixtures.variantInherits,
    });
    expect(preview.lines).toEqual([
      { label: "Товар", value: "Кава Арабіка" },
      { label: PREVIEW_CHANGES_LABEL, value: PREVIEW_NO_CHANGES },
    ]);
  });

  it("cards the status transition for a product and for a variant", async () => {
    const product = await previewOf(archiveProduct, {
      productId: fixtures.productA,
    });
    expect(product.title).toBe("Архівувати товар: Кава Арабіка");
    expect(product.lines).toEqual([
      { label: "Статус", value: "активний → архівований" },
    ]);

    const variant = await previewOf(restoreVariant, {
      variantId: fixtures.variantArchived,
    });
    expect(variant.title).toBe("Відновити варіант: Стара фасовка");
    expect(variant.lines).toEqual([
      { label: "Товар", value: "Кава Арабіка" },
      { label: "Статус", value: "архівований → активний" },
    ]);
  });

  it("leaves the row untouched while the card is issued", async () => {
    const rows = await kit.db.runtime.db
      .select({ name: products.name, status: products.status })
      .from(products)
      .where(eq(products.id, fixtures.productA));
    expect(rows[0]).toEqual({ name: "Кава Арабіка", status: "active" });
  });

  it("refuses a foreign product exactly like a missing one", async () => {
    expectSameRefusal(
      await invokeForCard(updateProduct, {
        productId: fixtures.productB,
        name: "Спроба",
        basePriceMinor: "100",
        currency: "UAH",
      }),
      await invokeForCard(updateProduct, {
        productId: fixtures.missingId,
        name: "Спроба",
        basePriceMinor: "100",
        currency: "UAH",
      }),
    );
  });

  it("refuses a foreign variant exactly like a missing one and names nobody", async () => {
    const foreign = await invokeForCard(archiveVariant, {
      variantId: fixtures.variantB,
    });
    expectSameRefusal(
      foreign,
      await invokeForCard(archiveVariant, { variantId: fixtures.missingId }),
    );
    expect(JSON.stringify(foreign)).not.toContain("Чужий варіант");
  });
});
