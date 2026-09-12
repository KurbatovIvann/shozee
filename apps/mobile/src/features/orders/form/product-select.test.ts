import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import { itemCountLabel } from "../shared/item-count";
import {
  filterProductSelectRows,
  productPickerParentSubtitle,
  resolveProductSelectListState,
  visibleProductSelectRows,
  type ProductSelectRow,
} from "./product-select";

describe("productPickerParentSubtitle", () => {
  it("uses none / count copy until variants are selected, then count · names", () => {
    const uk = ordersCopy("uk").create;
    const en = ordersCopy("en").create;
    expect(
      productPickerParentSubtitle({
        variantCount: 0,
        selectedNames: [],
        noneLabel: uk.variantsNone,
        countLabel: itemCountLabel(2, "uk", uk.variants),
        selectedLabel: uk.variantsSelected,
      }),
    ).toBe("Без варіантів");
    expect(
      productPickerParentSubtitle({
        variantCount: 2,
        selectedNames: [],
        noneLabel: uk.variantsNone,
        countLabel: itemCountLabel(2, "uk", uk.variants),
        selectedLabel: uk.variantsSelected,
      }),
    ).toBe("2 варіанти");
    expect(
      productPickerParentSubtitle({
        variantCount: 2,
        selectedNames: ["1 кг", "Шоколад"],
        noneLabel: uk.variantsNone,
        countLabel: itemCountLabel(2, "uk", uk.variants),
        selectedLabel: uk.variantsSelected,
      }),
    ).toBe("2 вибрано · 1 кг, Шоколад");
    expect(
      productPickerParentSubtitle({
        variantCount: 2,
        selectedNames: ["1 kg", "Chocolate"],
        noneLabel: en.variantsNone,
        countLabel: itemCountLabel(2, "en", en.variants),
        selectedLabel: en.variantsSelected,
      }),
    ).toBe("2 selected · 1 kg, Chocolate");
  });
});

describe("filterProductSelectRows", () => {
  it("does not walk the catalog when the picker session is closed", () => {
    const products = new Proxy([] as ProductSelectRow[], {
      get(): never {
        throw new Error("closed session must not read the catalog");
      },
    });
    expect(filterProductSelectRows(products, "торт", false)).toEqual([]);
  });

  it("filters by name only while the session is open", () => {
    const products: ProductSelectRow[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Торт",
        hasVariants: false,
        variantsLabel: "Без варіантів",
        thumbnailFileId: null,
        thumbnailUrl: null,
        thumbnailFailed: false,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Кава",
        hasVariants: false,
        variantsLabel: "Без варіантів",
        thumbnailFileId: null,
        thumbnailUrl: null,
        thumbnailFailed: false,
      },
    ];
    expect(filterProductSelectRows(products, "", true)).toBe(products);
    expect(
      filterProductSelectRows(products, "тор", true).map((row) => row.id),
    ).toEqual([products[0]?.id]);
  });
});

describe("visibleProductSelectRows", () => {
  const products: ProductSelectRow[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Торт",
      hasVariants: false,
      variantsLabel: "Без варіантів",
      thumbnailFileId: null,
      thumbnailUrl: null,
      thumbnailFailed: false,
    },
  ];

  it("returns the caller's rows untouched when server-filtered", () => {
    expect(
      visibleProductSelectRows({
        products,
        query: "торт",
        sessionOpen: true,
        serverFiltered: true,
      }),
    ).toBe(products);
  });

  it("filters locally when not server-filtered", () => {
    expect(
      visibleProductSelectRows({
        products,
        query: "кава",
        sessionOpen: true,
        serverFiltered: false,
      }),
    ).toEqual([]);
  });

  it("stays empty while the session is closed even when server-filtered", () => {
    expect(
      visibleProductSelectRows({
        products,
        query: "торт",
        sessionOpen: false,
        serverFiltered: true,
      }),
    ).toEqual([]);
  });
});

describe("resolveProductSelectListState", () => {
  const products: ProductSelectRow[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Торт",
      hasVariants: false,
      variantsLabel: "Без варіантів",
      thumbnailFileId: null,
      thumbnailUrl: null,
      thumbnailFailed: false,
    },
  ];

  it("shows loading while the first page of a controlled query loads", () => {
    expect(
      resolveProductSelectListState({
        products: [],
        query: "торт",
        sessionOpen: true,
        serverFiltered: true,
        loadingMore: true,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("shows empty once a controlled query settles with no rows", () => {
    expect(
      resolveProductSelectListState({
        products: [],
        query: "торт",
        sessionOpen: true,
        serverFiltered: true,
        loadingMore: false,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows empty for an uncontrolled query even while loadingMore is true", () => {
    expect(
      resolveProductSelectListState({
        products: [],
        query: "торт",
        sessionOpen: true,
        serverFiltered: false,
        loadingMore: true,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("stays empty while the session is closed even when loading", () => {
    expect(
      resolveProductSelectListState({
        products: [],
        query: "",
        sessionOpen: false,
        serverFiltered: true,
        loadingMore: true,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("shows items once rows are visible regardless of loadingMore", () => {
    expect(
      resolveProductSelectListState({
        products,
        query: "",
        sessionOpen: true,
        serverFiltered: false,
        loadingMore: true,
      }),
    ).toEqual({ kind: "items", items: products });
  });
});
