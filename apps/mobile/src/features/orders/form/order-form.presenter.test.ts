import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import { EMPTY_ORDER_THUMBNAIL } from "../shared/order-thumbnails";
import {
  presentOrderFormCopy,
  presentOrderFormFooter,
  presentProductSelectRows,
  presentProductsValue,
  presentVariantSelectRows,
} from "./order-form.presenter";

const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "22222222-2222-4222-8222-222222222222";

describe("order-form presenter rows", () => {
  it("keeps unrelated product row primitives equal when picks do not change", () => {
    const formCopy = ordersCopy("uk").create;
    const productRows = [
      { id: PRODUCT_A, name: "Торт", variantCount: 0 },
      { id: PRODUCT_B, name: "Кава", variantCount: 2 },
    ];
    const thumbnails = new Map([
      [PRODUCT_A, EMPTY_ORDER_THUMBNAIL],
      [PRODUCT_B, EMPTY_ORDER_THUMBNAIL],
    ]);
    const args = {
      productRows,
      thumbnailsByProductId: thumbnails,
      picks: [] as const,
      formCopy,
      locale: "uk" as const,
    };
    const first = presentProductSelectRows(args);
    const second = presentProductSelectRows(args);
    expect(first[0]).toEqual(second[0]);
    expect(first[1]?.hasVariants).toBe(true);
    expect(presentProductsValue(0, formCopy.addProductsValue)).toBeUndefined();
    expect(presentProductsValue(2, formCopy.addProductsValue)).toBe(
      "2 у замовленні",
    );
    expect(
      presentOrderFormFooter({
        itemCount: 0,
        locale: "uk",
        items: ordersCopy("uk").items,
        emptyLabel: formCopy.emptyPositions,
      }),
    ).toEqual({
      empty: true,
      emptyLabel: "Без позицій",
      metaLabel: "",
    });
    expect(
      presentOrderFormFooter({
        itemCount: 2,
        locale: "uk",
        items: ordersCopy("uk").items,
        emptyLabel: formCopy.emptyPositions,
      }),
    ).toEqual({
      empty: false,
      emptyLabel: "",
      metaLabel: "2 позиції",
    });
    expect(presentVariantSelectRows([{ id: PRODUCT_A, name: "1 кг" }])).toEqual(
      [{ id: PRODUCT_A, name: "1 кг" }],
    );
  });
});

describe("presentOrderFormCopy variant conflict", () => {
  it("maps CONFLICT onto the items picker and suppresses the unavailable banner", () => {
    const formCopy = ordersCopy("uk").create;
    const resolved = presentOrderFormCopy({
      formCopy,
      submitted: true,
      customerMessage: undefined,
      itemsError: undefined,
      commentMessage: undefined,
      serverFields: {
        customer: null,
        items: "variant_required",
        comment: null,
      },
      localBanner: null,
      failureKind: "conflict",
      wireCode: "CONFLICT",
      pending: false,
      clientReady: true,
      canCreate: true,
    });
    expect(resolved.itemsError).toBe(formCopy.errors.itemsVariantRequired);
    expect(resolved.banner).toBeNull();
    const archived = presentOrderFormCopy({
      formCopy,
      submitted: true,
      customerMessage: undefined,
      itemsError: undefined,
      commentMessage: undefined,
      serverFields: {
        customer: null,
        items: "no_active_variants",
        comment: null,
      },
      localBanner: null,
      failureKind: "conflict",
      wireCode: "CONFLICT",
      pending: false,
      clientReady: true,
      canCreate: true,
    });
    expect(archived.itemsError).toBe(formCopy.errors.itemsNoActiveVariants);
    expect(archived.banner).toBeNull();
  });
});

describe("order-form kit and sheet hygiene", () => {
  it("adopts form-kit save/guard, extracts presenter and sheets, and skips closed-sheet work", () => {
    const hook = readFileSync(
      new URL("./use-order-form.ts", import.meta.url),
      "utf8",
    );
    const save = readFileSync(
      new URL("./use-order-save.ts", import.meta.url),
      "utf8",
    );
    const saveLoop = readFileSync(
      new URL("./order-form-save.ts", import.meta.url),
      "utf8",
    );
    const sheet = readFileSync(
      new URL("./product-select-sheet.tsx", import.meta.url),
      "utf8",
    );
    expect(hook).toContain("useUnsavedGuard");
    expect(hook).toContain("useOrderFormSheets");
    expect(hook).toContain("presentOrderFormFooter");
    expect(hook).not.toContain("useUnsavedOrderGuard");
    expect(save).toContain("useFormSave");
    expect(saveLoop).toContain("runFormSave");
    expect(sheet).toContain("visibleProductSelectRows");
    expect(sheet).toContain("memo(function ProductPickerRow");
    expect(sheet).toContain("{props.sessionOpen ? (");
    expect(sheet).toContain("onPress: (id: string) => void");
  });

  it("blocks save while catalog getProduct is pending or errored, without variant_required", () => {
    const hook = readFileSync(
      new URL("./use-order-form.ts", import.meta.url),
      "utf8",
    );
    const lookups = readFileSync(
      new URL("./use-order-form-lookups.ts", import.meta.url),
      "utf8",
    );
    const plan = readFileSync(
      new URL("./order-form-plan.ts", import.meta.url),
      "utf8",
    );
    expect(lookups).toContain("classifyCatalogFactsLoad");
    expect(lookups).toContain("catalogQueryLoadStatus");
    expect(lookups).toContain("catalogFactsBlockSubmit");
    expect(hook).toContain("catalogFactsBlockSubmit");
    expect(hook).toContain('lookups.catalogFactsStatus === "error"');
    expect(hook).toContain("formCopy.variantsError");
    expect(hook).toContain("if (catalogFactsBlocked)");
    expect(plan).toContain("catalogFactsReadyForDraft");
    expect(plan).toContain("if (facts === undefined)");
    expect(plan).toContain("return null;");
  });
});
