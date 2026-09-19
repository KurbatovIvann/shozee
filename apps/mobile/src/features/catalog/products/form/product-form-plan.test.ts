import { describe, expect, it } from "vitest";

import type { GetProductOutput } from "../api/product-detail-query";
import {
  addVariantRow,
  draftFromProduct,
  emptyProductFormDraft,
  formatProductFormFooterPrice,
  productFormFooterPriceMuted,
  snapshotFromDraft,
  snapshotFromProduct,
  upsertVariantDraft,
  validateVariantSheet,
  variantDraftToSheet,
  variantSheetPriceText,
  type ProductFormDraft,
} from "./product-form-draft";
import {
  applyWriteSuccess,
  createProductPayload,
  parseThenPlanProductFormSave,
  planProductFormSave,
  remainingFormWrites,
  writesEqual,
  type ProductFormWrite,
} from "./product-form-plan";
import { productFormResolver } from "./product-form.schema";

const PRODUCT_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";

const loaded: GetProductOutput = {
  id: PRODUCT_ID,
  name: "Торт",
  basePriceMinor: "150000",
  currency: "UAH",
  status: "active",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  imageFileIds: [],
  variants: [
    {
      id: VARIANT_ID,
      name: "1 кг",
      status: "active",
      basePriceMinor: "180000",
      currency: "UAH",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "0.5 кг",
      status: "archived",
      basePriceMinor: null,
      currency: null,
    },
  ],
};

function validCreateDraft(): ProductFormDraft {
  return {
    name: "  Торт  ",
    priceText: "1 500",
    nextDraftSerial: 2,
    variants: [
      {
        key: "draft-1",
        variantId: null,
        name: "1 кг",
        priceText: "1800",
        archived: false,
      },
      {
        key: "draft-empty",
        variantId: null,
        name: "  ",
        priceText: "",
        archived: false,
      },
    ],
  };
}

describe("createProductPayload", () => {
  it("sends trimmed name, canonical minor units, UAH, and paired variant overrides", () => {
    const payload = createProductPayload(validCreateDraft());
    expect(payload?.input).toEqual({
      name: "Торт",
      basePriceMinor: "150000",
      currency: "UAH",
      variants: [{ name: "1 кг", basePriceMinor: "180000", currency: "UAH" }],
    });
    expect(payload?.variantKeys).toEqual(["draft-1"]);
    expect(Object.keys(payload?.input.variants?.[0] ?? {})).toEqual([
      "name",
      "basePriceMinor",
      "currency",
    ]);
  });

  it("omits variants and unpaired override currency when none are set", () => {
    const payload = createProductPayload({
      name: "Торт",
      priceText: "10",
      nextDraftSerial: 2,
      variants: [
        {
          key: "draft-1",
          variantId: null,
          name: "Класичний",
          priceText: "",
          archived: false,
        },
      ],
    });
    expect(payload?.input.variants).toEqual([{ name: "Класичний" }]);
    expect(Object.keys(payload?.input.variants?.[0] ?? {})).toEqual(["name"]);
  });
});

describe("planProductFormSave", () => {
  it("submits create and retries the same attempt after a network failure", () => {
    const first = planProductFormSave({
      mode: "create",
      productId: null,
      draft: validCreateDraft(),
      baseline: null,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(first.kind).toBe("write");
    if (first.kind !== "write") {
      return;
    }
    expect(first.write.kind).toBe("createProduct");
    expect(
      planProductFormSave({
        mode: "create",
        productId: null,
        draft: validCreateDraft(),
        baseline: null,
        lastWrite: first.write,
        lastFailureKind: "network",
      }),
    ).toEqual({ kind: "retry" });
  });

  it("stays invalid without calling transport", () => {
    expect(
      planProductFormSave({
        mode: "create",
        productId: null,
        draft: emptyProductFormDraft(),
        baseline: null,
        lastWrite: null,
        lastFailureKind: null,
      }).kind,
    ).toBe("invalid");
  });

  it("plans product then variant writes and noops when unchanged", () => {
    const draft = draftFromProduct(loaded);
    const baseline = snapshotFromDraft(draft);
    expect(baseline).not.toBeNull();
    if (baseline === null) {
      return;
    }
    expect(
      planProductFormSave({
        mode: "edit",
        productId: PRODUCT_ID,
        draft,
        baseline,
        lastWrite: null,
        lastFailureKind: null,
      }),
    ).toEqual({ kind: "noop" });

    const renamed = { ...draft, name: "Наполеон" };
    const planned = planProductFormSave({
      mode: "edit",
      productId: PRODUCT_ID,
      draft: renamed,
      baseline,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(planned).toEqual({
      kind: "write",
      write: {
        kind: "updateProduct",
        input: {
          productId: PRODUCT_ID,
          name: "Наполеон",
          basePriceMinor: "150000",
          currency: "UAH",
        },
      },
    });
  });
});

describe("remainingFormWrites", () => {
  it("emits updateProduct, updateVariant, and createVariant in that order", () => {
    const draft = addVariantRow({
      ...draftFromProduct(loaded),
      name: "Наполеон",
      variants: [
        {
          key: VARIANT_ID,
          variantId: VARIANT_ID,
          name: "2 кг",
          priceText: "1800",
          archived: false,
        },
        {
          key: "22222222-2222-4222-8222-222222222222",
          variantId: "22222222-2222-4222-8222-222222222222",
          name: "0.5 кг",
          priceText: "",
          archived: true,
        },
      ],
    });
    const withNew = {
      ...draft,
      variants: draft.variants.map((variant) =>
        variant.variantId === null ? { ...variant, name: "Міні" } : variant,
      ),
    };
    const baseline = snapshotFromDraft(draftFromProduct(loaded));
    const snapshot = snapshotFromDraft(withNew);
    expect(baseline).not.toBeNull();
    expect(snapshot).not.toBeNull();
    if (baseline === null || snapshot === null) {
      return;
    }
    const writes = remainingFormWrites(PRODUCT_ID, snapshot, baseline);
    expect(writes.map((write) => write.kind)).toEqual([
      "updateProduct",
      "updateVariant",
      "createVariant",
    ]);
    const created = writes[2];
    expect(created?.kind).toBe("createVariant");
    if (created?.kind === "createVariant") {
      expect(created.input).toEqual({ productId: PRODUCT_ID, name: "Міні" });
    }
  });

  it("clears a price override with an explicit null pair", () => {
    const draft = {
      ...draftFromProduct(loaded),
      variants: draftFromProduct(loaded).variants.map((variant) =>
        variant.key === VARIANT_ID ? { ...variant, priceText: "" } : variant,
      ),
    };
    const baseline = snapshotFromProduct(loaded);
    const snapshot = snapshotFromDraft(draft);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) {
      return;
    }
    const writes = remainingFormWrites(PRODUCT_ID, snapshot, baseline);
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(write?.kind).toBe("updateVariant");
    if (write?.kind === "updateVariant") {
      expect(write.input).toEqual({
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        name: "1 кг",
        basePriceMinor: null,
        currency: null,
      });
    }
  });
});

describe("applyWriteSuccess", () => {
  it("marks create done and advances edit writes after a created variant id", () => {
    const createWrite: ProductFormWrite = {
      kind: "createProduct",
      input: {
        name: "Торт",
        basePriceMinor: "100",
        currency: "UAH",
      },
      variantKeys: [],
    };
    expect(
      applyWriteSuccess({
        draft: emptyProductFormDraft(),
        baseline: null,
        write: createWrite,
        result: { kind: "product", productId: PRODUCT_ID },
      }).done,
    ).toBe(true);

    const draft = addVariantRow(draftFromProduct(loaded));
    const named = {
      ...draft,
      variants: draft.variants.map((variant) =>
        variant.variantId === null ? { ...variant, name: "Міні" } : variant,
      ),
    };
    const baseline = snapshotFromDraft(draftFromProduct(loaded));
    const snapshot = snapshotFromDraft(named);
    if (baseline === null || snapshot === null) {
      return;
    }
    const write = remainingFormWrites(PRODUCT_ID, snapshot, baseline)[0];
    expect(write?.kind).toBe("createVariant");
    if (write === undefined || write.kind !== "createVariant") {
      return;
    }
    const applied = applyWriteSuccess({
      draft: named,
      baseline,
      write,
      result: {
        kind: "variant",
        variantId: "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(applied.done).toBe(true);
    expect(
      applied.draft.variants.some(
        (variant) =>
          variant.variantId === "33333333-3333-4333-8333-333333333333",
      ),
    ).toBe(true);
  });

  it("stamps createProduct variant ids so remainingFormWrites is empty", () => {
    const draft = validCreateDraft();
    const created = createProductPayload(draft);
    expect(created).not.toBeNull();
    if (created === null) {
      return;
    }
    const applied = applyWriteSuccess({
      draft,
      baseline: null,
      write: {
        kind: "createProduct",
        input: created.input,
        variantKeys: created.variantKeys,
      },
      result: {
        kind: "product",
        productId: PRODUCT_ID,
        variants: [
          {
            variantId: VARIANT_ID,
            name: "1 кг",
            basePriceMinor: "180000",
            currency: "UAH",
          },
        ],
      },
    });
    expect(applied.done).toBe(true);
    expect(
      applied.draft.variants.find((variant) => variant.name.trim() === "1 кг")
        ?.variantId,
    ).toBe(VARIANT_ID);
    const snapshot = snapshotFromDraft(applied.draft);
    expect(snapshot).not.toBeNull();
    expect(applied.baseline).not.toBeNull();
    if (snapshot === null || applied.baseline === null) {
      return;
    }
    expect(remainingFormWrites(PRODUCT_ID, snapshot, applied.baseline)).toEqual(
      [],
    );
  });

  it("matches created variants by name and price when output order differs", () => {
    const draft: ProductFormDraft = {
      name: "Торт",
      priceText: "10",
      nextDraftSerial: 3,
      variants: [
        {
          key: "draft-1",
          variantId: null,
          name: "1 кг",
          priceText: "1800",
          archived: false,
        },
        {
          key: "draft-2",
          variantId: null,
          name: "0.5 кг",
          priceText: "900",
          archived: false,
        },
      ],
    };
    const created = createProductPayload(draft);
    expect(created).not.toBeNull();
    if (created === null) {
      return;
    }
    const secondId = "22222222-2222-4222-8222-222222222222";
    const applied = applyWriteSuccess({
      draft,
      baseline: null,
      write: {
        kind: "createProduct",
        input: created.input,
        variantKeys: created.variantKeys,
      },
      result: {
        kind: "product",
        productId: PRODUCT_ID,
        variants: [
          {
            variantId: secondId,
            name: "0.5 кг",
            basePriceMinor: "90000",
            currency: "UAH",
          },
          {
            variantId: VARIANT_ID,
            name: "1 кг",
            basePriceMinor: "180000",
            currency: "UAH",
          },
        ],
      },
    });
    expect(
      applied.draft.variants.map((variant) => ({
        name: variant.name,
        variantId: variant.variantId,
      })),
    ).toEqual([
      { name: "1 кг", variantId: VARIANT_ID },
      { name: "0.5 кг", variantId: secondId },
    ]);
    const snapshot = snapshotFromDraft(applied.draft);
    expect(snapshot).not.toBeNull();
    expect(applied.baseline).not.toBeNull();
    if (snapshot === null || applied.baseline === null) {
      return;
    }
    expect(remainingFormWrites(PRODUCT_ID, snapshot, applied.baseline)).toEqual(
      [],
    );
  });
});

describe("variant sheet save into the write plan", () => {
  it("maps inherit vs custom price from the switch", () => {
    expect(variantDraftToSheet(null)).toEqual({
      name: "",
      customPrice: false,
      priceText: "",
    });
    expect(
      variantDraftToSheet({
        key: "draft-1",
        variantId: null,
        name: "1 кг",
        priceText: "1800",
        archived: false,
      }),
    ).toEqual({
      name: "1 кг",
      customPrice: true,
      priceText: "1800",
    });
    expect(
      variantSheetPriceText({
        name: "1 кг",
        customPrice: false,
        priceText: "1800",
      }),
    ).toBe("");
    expect(
      validateVariantSheet({
        name: "",
        customPrice: true,
        priceText: "",
      }),
    ).toEqual({ name: "required", price: "required" });
    expect(
      validateVariantSheet({
        name: "Ваніль",
        customPrice: false,
        priceText: "",
      }),
    ).toEqual({ name: null, price: null });
  });

  it("upserts a new variant into createProduct variants", () => {
    const draft = upsertVariantDraft(
      { ...emptyProductFormDraft(), name: "Торт", priceText: "10" },
      { key: null, name: "1 кг", priceText: "1800" },
    );
    const payload = createProductPayload(draft);
    expect(payload?.input.variants).toEqual([
      { name: "1 кг", basePriceMinor: "180000", currency: "UAH" },
    ]);
  });

  it("upserts a new inherited variant as createVariant on edit", () => {
    const origin = draftFromProduct(loaded);
    const draft = upsertVariantDraft(origin, {
      key: null,
      name: "Міні",
      priceText: "",
    });
    const baseline = snapshotFromProduct(loaded);
    const plan = planProductFormSave({
      mode: "edit",
      productId: PRODUCT_ID,
      draft,
      baseline,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") {
      return;
    }
    expect(plan.write.kind).toBe("createVariant");
    if (plan.write.kind === "createVariant") {
      expect(plan.write.input).toEqual({
        productId: PRODUCT_ID,
        name: "Міні",
      });
    }
  });

  it("upserts an edited variant as updateVariant", () => {
    const origin = draftFromProduct(loaded);
    const draft = upsertVariantDraft(origin, {
      key: VARIANT_ID,
      name: "2 кг",
      priceText: "1800",
    });
    const baseline = snapshotFromProduct(loaded);
    const plan = planProductFormSave({
      mode: "edit",
      productId: PRODUCT_ID,
      draft,
      baseline,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(plan).toEqual({
      kind: "write",
      write: {
        kind: "updateVariant",
        key: VARIANT_ID,
        input: {
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          name: "2 кг",
          basePriceMinor: "180000",
          currency: "UAH",
        },
      },
    });
  });

  it("formats an empty footer price as zero hryvnia and mutes zero/invalid amounts", () => {
    expect(formatProductFormFooterPrice("")).toMatch(/0/);
    expect(formatProductFormFooterPrice("10")).toMatch(/10/);
    expect(productFormFooterPriceMuted("")).toBe(true);
    expect(productFormFooterPriceMuted("0")).toBe(true);
    expect(productFormFooterPriceMuted("10")).toBe(false);
  });
});

describe("parseThenPlanProductFormSave", () => {
  it("runs the UI draft schema before planning a write", () => {
    const invalid = parseThenPlanProductFormSave({
      mode: "create",
      productId: null,
      draft: emptyProductFormDraft(),
      baseline: null,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(invalid.kind).toBe("invalid");
    if (invalid.kind !== "invalid") {
      return;
    }
    expect(invalid.errors.name).toBe("required");
    expect(invalid.errors.price).toBe("required");
  });

  it("maps comma major units onto wire minor units after a successful UI parse", () => {
    const draft: ProductFormDraft = {
      name: "Торт",
      priceText: "123,50",
      variants: [],
      nextDraftSerial: 1,
    };
    const parsed = parseThenPlanProductFormSave({
      mode: "create",
      productId: null,
      draft,
      baseline: null,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(parsed.kind).toBe("write");
    if (parsed.kind !== "write" || parsed.write.kind !== "createProduct") {
      return;
    }
    expect(parsed.write.input.basePriceMinor).toBe("12350");
  });

  it("uses the same copy keys as productFormResolver on invalid parent fields", async () => {
    const resolverResult = await productFormResolver(
      emptyProductFormDraft(),
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(resolverResult.errors.name?.message).toBe("required");
    expect(resolverResult.errors.priceText?.message).toBe("required");
    const planned = parseThenPlanProductFormSave({
      mode: "create",
      productId: null,
      draft: emptyProductFormDraft(),
      baseline: null,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(planned.kind).toBe("invalid");
    if (planned.kind !== "invalid") {
      return;
    }
    expect(planned.errors.name).toBe(resolverResult.errors.name?.message);
    expect(planned.errors.price).toBe(resolverResult.errors.priceText?.message);
  });

  it("rejects a variant with an empty name and a filled price before planning", async () => {
    const draft: ProductFormDraft = {
      name: "Торт",
      priceText: "10",
      nextDraftSerial: 1,
      variants: [
        {
          key: "draft-1",
          variantId: null,
          name: "",
          priceText: "12",
          archived: false,
        },
      ],
    };
    const resolverResult = await productFormResolver(draft, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(resolverResult.errors.variants?.[0]?.name?.message).toBe("required");
    const planned = parseThenPlanProductFormSave({
      mode: "create",
      productId: null,
      draft,
      baseline: null,
      lastWrite: null,
      lastFailureKind: null,
    });
    expect(planned.kind).toBe("invalid");
    if (planned.kind !== "invalid") {
      return;
    }
    expect(planned.errors.variants["draft-1"]?.name).toBe("required");
  });
});

describe("writesEqual", () => {
  it("compares writes field-wise instead of by JSON snapshot", () => {
    const create: ProductFormWrite = {
      kind: "createProduct",
      input: {
        name: "Торт",
        basePriceMinor: "100",
        currency: "UAH",
        variants: [{ name: "1 кг", basePriceMinor: "180000", currency: "UAH" }],
      },
      variantKeys: ["draft-1"],
    };
    expect(writesEqual(create, { ...create, variantKeys: ["draft-1"] })).toBe(
      true,
    );
    expect(writesEqual(create, { ...create, variantKeys: ["draft-2"] })).toBe(
      false,
    );
    expect(
      writesEqual(create, {
        ...create,
        input: { ...create.input, name: "Наполеон" },
      }),
    ).toBe(false);

    const update: ProductFormWrite = {
      kind: "updateProduct",
      input: {
        productId: PRODUCT_ID,
        name: "Торт",
        basePriceMinor: "150000",
        currency: "UAH",
      },
    };
    expect(writesEqual(update, { ...update })).toBe(true);
    expect(writesEqual(update, create)).toBe(false);

    const createVariant: ProductFormWrite = {
      kind: "createVariant",
      key: "draft-1",
      input: { productId: PRODUCT_ID, name: "Міні" },
    };
    expect(
      writesEqual(createVariant, {
        kind: "createVariant",
        key: "draft-1",
        input: { productId: PRODUCT_ID, name: "Міні" },
      }),
    ).toBe(true);
    expect(
      writesEqual(createVariant, {
        ...createVariant,
        input: {
          productId: PRODUCT_ID,
          name: "Міні",
          basePriceMinor: "100",
          currency: "UAH",
        },
      }),
    ).toBe(false);

    const updateVariant: ProductFormWrite = {
      kind: "updateVariant",
      key: VARIANT_ID,
      input: {
        productId: PRODUCT_ID,
        variantId: VARIANT_ID,
        name: "2 кг",
        basePriceMinor: "180000",
        currency: "UAH",
      },
    };
    expect(writesEqual(updateVariant, { ...updateVariant })).toBe(true);
    expect(
      writesEqual(updateVariant, {
        ...updateVariant,
        input: { ...updateVariant.input, name: "3 кг" },
      }),
    ).toBe(false);
  });
});
