/**
 * Product form write planner (SHO-163). UI parse happens first via
 * `parseProductFormUiDraft`; this file turns a valid draft into catalog
 * writes and applies success onto the snapshot.
 */
import type { WireErrorCode } from "@showzy/contract";

import type { ContractClient } from "../../../../api/client";
import type { QueryFailureKind } from "../../../../api/errors";
import {
  PRODUCT_CURRENCY,
  PRODUCT_FORM_MAX_VARIANTS,
} from "../shared/product-caps";
import {
  compactDraft,
  isProductFormValid,
  parseProductFormUiDraft,
  snapshotFromDraft,
  validateProductForm,
  type ProductFormDraft,
  type ProductFormFieldErrors,
  type ProductFormMode,
  type ProductFormSnapshot,
} from "./product-form-draft";

type CatalogClient = ContractClient["client"]["catalog"];
export type CreateProductPayload = Parameters<
  CatalogClient["createProduct"]
>[0];
export type UpdateProductPayload = Parameters<
  CatalogClient["updateProduct"]
>[0];
export type CreateVariantPayload = Parameters<
  CatalogClient["createVariant"]
>[0];
export type UpdateVariantPayload = Parameters<
  CatalogClient["updateVariant"]
>[0];

export type ProductFormWrite =
  | {
      readonly kind: "createProduct";
      readonly input: CreateProductPayload;
      readonly variantKeys: readonly string[];
    }
  | { readonly kind: "updateProduct"; readonly input: UpdateProductPayload }
  | {
      readonly kind: "createVariant";
      readonly key: string;
      readonly input: CreateVariantPayload;
    }
  | {
      readonly kind: "updateVariant";
      readonly key: string;
      readonly input: UpdateVariantPayload;
    };

export type ProductFormSavePlan =
  | { readonly kind: "invalid"; readonly errors: ProductFormFieldErrors }
  | { readonly kind: "retry" }
  | { readonly kind: "noop" }
  | { readonly kind: "write"; readonly write: ProductFormWrite };

export type CreatedProductVariantView = {
  readonly variantId: string;
  readonly name: string;
  readonly basePriceMinor: string | null;
  readonly currency: string | null;
};

export type ProductFormMutationResult =
  | {
      readonly kind: "product";
      readonly productId: string;
      readonly variants?: readonly CreatedProductVariantView[];
    }
  | { readonly kind: "variant"; readonly variantId: string };

const RETRYABLE_FAILURE: ReadonlySet<QueryFailureKind> = new Set([
  "network",
  "offline",
  "timeout",
  "rate_limited",
  "internal",
]);

const RETRYABLE_WIRE: ReadonlySet<WireErrorCode> = new Set([
  "RETRY_IN_PROGRESS",
  "IDEMPOTENCY_CONFLICT",
]);

function variantPayloadFields(priceMinor: string | null): {
  readonly basePriceMinor?: string;
  readonly currency?: typeof PRODUCT_CURRENCY;
} {
  if (priceMinor === null) {
    return {};
  }
  return { basePriceMinor: priceMinor, currency: PRODUCT_CURRENCY };
}

function variantOverrideUpdateFields(priceMinor: string | null): {
  readonly basePriceMinor: string | null;
  readonly currency: typeof PRODUCT_CURRENCY | null;
} {
  if (priceMinor === null) {
    return { basePriceMinor: null, currency: null };
  }
  return { basePriceMinor: priceMinor, currency: PRODUCT_CURRENCY };
}

export function createProductPayload(draft: ProductFormDraft): {
  readonly input: CreateProductPayload;
  readonly variantKeys: readonly string[];
} | null {
  const snapshot = snapshotFromDraft(draft);
  if (snapshot === null) {
    return null;
  }
  const variants = snapshot.variants.map((variant) => ({
    name: variant.name,
    ...variantPayloadFields(variant.priceMinor),
  }));
  return {
    variantKeys: snapshot.variants.map((variant) => variant.key),
    input: {
      name: snapshot.name,
      basePriceMinor: snapshot.priceMinor,
      currency: PRODUCT_CURRENCY,
      ...(variants.length === 0 ? {} : { variants }),
    },
  };
}

export function remainingFormWrites(
  productId: string,
  snapshot: ProductFormSnapshot,
  baseline: ProductFormSnapshot,
): readonly ProductFormWrite[] {
  const writes: ProductFormWrite[] = [];
  if (
    snapshot.name !== baseline.name ||
    snapshot.priceMinor !== baseline.priceMinor
  ) {
    writes.push({
      kind: "updateProduct",
      input: {
        productId,
        name: snapshot.name,
        basePriceMinor: snapshot.priceMinor,
        currency: PRODUCT_CURRENCY,
      },
    });
  }
  const baselineByKey = new Map(
    baseline.variants.map((variant) => [variant.key, variant]),
  );
  for (const variant of snapshot.variants) {
    const previous = baselineByKey.get(variant.key);
    if (variant.variantId === null) {
      writes.push({
        kind: "createVariant",
        key: variant.key,
        input: {
          productId,
          name: variant.name,
          ...variantPayloadFields(variant.priceMinor),
        },
      });
      continue;
    }
    if (
      previous !== undefined &&
      previous.name === variant.name &&
      previous.priceMinor === variant.priceMinor
    ) {
      continue;
    }
    writes.push({
      kind: "updateVariant",
      key: variant.key,
      input: {
        productId,
        variantId: variant.variantId,
        name: variant.name,
        ...variantOverrideUpdateFields(variant.priceMinor),
      },
    });
  }
  return writes;
}

function sameOptionalString(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return left === right;
}

function sameCreateProductVariants(
  left: CreateProductPayload["variants"],
  right: CreateProductPayload["variants"],
): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.name === other.name &&
      sameOptionalString(item.basePriceMinor, other.basePriceMinor)
    );
  });
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function writesEqual(
  left: ProductFormWrite,
  right: ProductFormWrite,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "createProduct":
      return (
        right.kind === "createProduct" &&
        left.input.name === right.input.name &&
        left.input.basePriceMinor === right.input.basePriceMinor &&
        sameCreateProductVariants(left.input.variants, right.input.variants) &&
        sameStringList(left.variantKeys, right.variantKeys)
      );
    case "updateProduct":
      return (
        right.kind === "updateProduct" &&
        left.input.productId === right.input.productId &&
        left.input.name === right.input.name &&
        left.input.basePriceMinor === right.input.basePriceMinor
      );
    case "createVariant":
      return (
        right.kind === "createVariant" &&
        left.key === right.key &&
        left.input.productId === right.input.productId &&
        left.input.name === right.input.name &&
        sameOptionalString(
          left.input.basePriceMinor,
          right.input.basePriceMinor,
        )
      );
    case "updateVariant":
      return (
        right.kind === "updateVariant" &&
        left.key === right.key &&
        left.input.productId === right.input.productId &&
        left.input.variantId === right.input.variantId &&
        left.input.name === right.input.name &&
        sameOptionalString(
          left.input.basePriceMinor,
          right.input.basePriceMinor,
        )
      );
  }
}

export function isProductFormRetryable(
  kind: QueryFailureKind | null,
  wireCode: WireErrorCode | null = null,
): boolean {
  if (wireCode !== null && RETRYABLE_WIRE.has(wireCode)) {
    return true;
  }
  return kind !== null && RETRYABLE_FAILURE.has(kind);
}

export function planProductFormSave(args: {
  readonly mode: ProductFormMode;
  readonly productId: string | null;
  readonly draft: ProductFormDraft;
  readonly baseline: ProductFormSnapshot | null;
  readonly lastWrite: ProductFormWrite | null;
  readonly lastFailureKind: QueryFailureKind | null;
  readonly lastWireCode?: WireErrorCode | null;
}): ProductFormSavePlan {
  const compacted = compactDraft(args.draft);
  if (compacted.variants.length > PRODUCT_FORM_MAX_VARIANTS) {
    return { kind: "invalid", errors: validateProductForm(compacted) };
  }
  const errors = validateProductForm(compacted);
  if (!isProductFormValid(errors)) {
    return { kind: "invalid", errors };
  }
  const retryable = isProductFormRetryable(
    args.lastFailureKind,
    args.lastWireCode ?? null,
  );
  if (args.mode === "create") {
    const created = createProductPayload(compacted);
    if (created === null) {
      return { kind: "invalid", errors };
    }
    const write: ProductFormWrite = {
      kind: "createProduct",
      input: created.input,
      variantKeys: created.variantKeys,
    };
    if (
      args.lastWrite !== null &&
      writesEqual(args.lastWrite, write) &&
      retryable
    ) {
      return { kind: "retry" };
    }
    return { kind: "write", write };
  }
  if (args.productId === null || args.baseline === null) {
    return { kind: "invalid", errors };
  }
  const snapshot = snapshotFromDraft(compacted);
  if (snapshot === null) {
    return { kind: "invalid", errors };
  }
  const writes = remainingFormWrites(args.productId, snapshot, args.baseline);
  if (writes.length === 0) {
    return { kind: "noop" };
  }
  const write = writes[0];
  if (write === undefined) {
    return { kind: "noop" };
  }
  if (
    args.lastWrite !== null &&
    writesEqual(args.lastWrite, write) &&
    retryable
  ) {
    return { kind: "retry" };
  }
  return { kind: "write", write };
}

/**
 * Gate the planner behind a successful UI draft parse (the same Zod
 * schema `productFormResolver` uses). Invalid parent fields never plan
 * a write.
 */
export function parseThenPlanProductFormSave(args: {
  readonly mode: ProductFormMode;
  readonly productId: string | null;
  readonly draft: ProductFormDraft;
  readonly baseline: ProductFormSnapshot | null;
  readonly lastWrite: ProductFormWrite | null;
  readonly lastFailureKind: QueryFailureKind | null;
  readonly lastWireCode?: WireErrorCode | null;
}): ProductFormSavePlan {
  const parsed = parseProductFormUiDraft(args.draft);
  if (!parsed.ok) {
    return { kind: "invalid", errors: parsed.errors };
  }
  return planProductFormSave({ ...args, draft: parsed.draft });
}

function writeProductId(write: ProductFormWrite): string | null {
  switch (write.kind) {
    case "createProduct":
      return null;
    case "updateProduct":
    case "createVariant":
    case "updateVariant":
      return write.input.productId;
  }
}

/**
 * `catalog.createProduct` returns variants sorted by id, not payload
 * order. Match each draft key to an unused created row by name + price,
 * then fall back to the next unused row.
 */
function stampCreateProductVariantIds(args: {
  readonly draft: ProductFormDraft;
  readonly variantKeys: readonly string[];
  readonly created: readonly CreatedProductVariantView[];
}): ProductFormDraft {
  const snapshot = snapshotFromDraft(args.draft);
  const remaining = [...args.created];
  const idByKey = new Map<string, string>();
  for (const key of args.variantKeys) {
    const snap = snapshot?.variants.find((variant) => variant.key === key);
    const matchIndex = remaining.findIndex(
      (row) =>
        snap !== undefined &&
        row.name === snap.name &&
        row.basePriceMinor === snap.priceMinor,
    );
    const matched =
      matchIndex >= 0 ? remaining.splice(matchIndex, 1)[0] : remaining.shift();
    if (matched === undefined) {
      continue;
    }
    idByKey.set(key, matched.variantId);
  }
  if (idByKey.size === 0) {
    return args.draft;
  }
  return {
    ...args.draft,
    variants: args.draft.variants.map((variant) => {
      const variantId = idByKey.get(variant.key);
      if (variantId === undefined) {
        return variant;
      }
      return { ...variant, key: variantId, variantId };
    }),
  };
}

export function applyWriteSuccess(args: {
  readonly draft: ProductFormDraft;
  readonly baseline: ProductFormSnapshot | null;
  readonly write: ProductFormWrite;
  readonly result: ProductFormMutationResult;
}): {
  readonly draft: ProductFormDraft;
  readonly baseline: ProductFormSnapshot | null;
  readonly done: boolean;
} {
  if (args.write.kind === "createProduct") {
    const created =
      args.result.kind === "product" ? (args.result.variants ?? []) : [];
    const draft = stampCreateProductVariantIds({
      draft: args.draft,
      variantKeys: args.write.variantKeys,
      created,
    });
    return {
      draft,
      baseline: snapshotFromDraft(draft) ?? args.baseline,
      done: true,
    };
  }
  const loaded = snapshotFromDraft(args.draft);
  let draft = args.draft;
  let baseline: ProductFormSnapshot = args.baseline ??
    loaded ?? {
      name: "",
      priceMinor: "0",
      variants: [],
    };

  if (args.write.kind === "updateProduct") {
    const write = args.write;
    baseline = {
      ...baseline,
      name: write.input.name,
      priceMinor: write.input.basePriceMinor,
    };
  } else if (args.write.kind === "createVariant") {
    const write = args.write;
    const newId =
      args.result.kind === "variant" ? args.result.variantId : write.key;
    draft = {
      ...draft,
      variants: draft.variants.map((variant) =>
        variant.key === write.key
          ? { ...variant, key: newId, variantId: newId }
          : variant,
      ),
    };
    const created = (snapshotFromDraft(draft)?.variants ?? []).find(
      (variant) => variant.key === newId,
    );
    baseline = {
      ...baseline,
      variants: [
        ...baseline.variants.filter((variant) => variant.key !== write.key),
        created ?? {
          key: newId,
          variantId: newId,
          name: write.input.name,
          priceMinor: write.input.basePriceMinor ?? null,
        },
      ],
    };
  } else {
    const write = args.write;
    baseline = {
      ...baseline,
      variants: baseline.variants.map((variant) =>
        variant.key === write.key
          ? {
              ...variant,
              name: write.input.name,
              priceMinor: write.input.basePriceMinor ?? null,
            }
          : variant,
      ),
    };
  }

  const productId = writeProductId(args.write);
  const snapshot = snapshotFromDraft(draft);
  const remaining =
    productId === null || snapshot === null
      ? []
      : remainingFormWrites(productId, snapshot, baseline);
  return { draft, baseline, done: remaining.length === 0 };
}
