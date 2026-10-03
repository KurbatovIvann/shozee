import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreview, ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { formatMoneyMinor } from "@showzy/module-kit/money-format";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { changeLines } from "@showzy/module-kit/preview-changes";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { createProductInputSchema } from "../actions/create-product.contract.js";
import type { createVariantInputSchema } from "../actions/create-variant.contract.js";
import type { updateProductInputSchema } from "../actions/update-product.contract.js";
import type { updateVariantInputSchema } from "../actions/update-variant.contract.js";
import { productStatusSchema } from "../wire.contract.js";

type PreviewEnv = ActionPreviewEnv;
type Contract = { readonly name: string };
type ProductStatus = z.output<typeof productStatusSchema>;

type CreateProductFields = z.output<typeof createProductInputSchema>;
type UpdateProductFields = z.output<typeof updateProductInputSchema>;
type CreateVariantFields = z.output<typeof createVariantInputSchema>;
type UpdateVariantFields = z.output<typeof updateVariantInputSchema>;

export const CATALOG_NAME_LABEL = "Назва";
export const PRODUCT_PRICE_LABEL = "Базова ціна";
export const VARIANT_PRICE_LABEL = "Ціна";
export const CATALOG_PRODUCT_LABEL = "Товар";
export const CATALOG_STATUS_LABEL = "Статус";
export const CATALOG_VARIANT_LABEL_PREFIX = "Варіант";
export const VARIANT_INHERITS_BASE = "за базовою ціною товару";

const STATUS_LABELS = {
  active: "активний",
  archived: "архівований",
} as const satisfies Record<ProductStatus, string>;

function statusLabel(status: string): string {
  return STATUS_LABELS[
    parseDbEnum(
      productStatusSchema,
      status,
      `catalog row has illegal status "${status}"`,
    )
  ];
}

function changeLine(
  label: string,
  stored: string | null,
  next: string,
): ActionPreviewLine {
  if (stored === null || stored === next) {
    return { label, value: next };
  }
  return { label, value: `${stored} → ${next}` };
}

function overridePrice(
  basePriceMinor: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (
    basePriceMinor === null ||
    basePriceMinor === undefined ||
    currency === null ||
    currency === undefined
  ) {
    return VARIANT_INHERITS_BASE;
  }
  return formatMoneyMinor(basePriceMinor, currency);
}

function storedOverridePrice(
  basePriceMinor: bigint | null,
  currency: string | null,
): string {
  return overridePrice(
    basePriceMinor === null ? null : moneyToCanonical(basePriceMinor),
    currency,
  );
}

function variantLineLabel(name: string): string {
  return `${CATALOG_VARIANT_LABEL_PREFIX}: ${name}`;
}

async function loadProduct(env: PreviewEnv, companyId: string, id: string) {
  const row = (
    await env.tx
      .select({
        name: products.name,
        basePriceMinor: products.basePriceMinor,
        currency: products.currency,
        status: products.status,
      })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.id, id)))
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

async function loadVariant(
  env: PreviewEnv,
  companyId: string,
  id: string,
  productId?: string,
) {
  const scope = [
    eq(productVariants.companyId, companyId),
    eq(productVariants.id, id),
  ];
  if (productId !== undefined) {
    scope.push(eq(productVariants.productId, productId));
  }
  const row = (
    await env.tx
      .select({
        productId: productVariants.productId,
        name: productVariants.name,
        basePriceMinor: productVariants.basePriceMinor,
        currency: productVariants.currency,
        status: productVariants.status,
      })
      .from(productVariants)
      .where(and(...scope))
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  const product = await loadProduct(env, companyId, row.productId);
  return { ...row, productName: product.name };
}

export function createProductPreview(
  contract: Contract,
): (input: CreateProductFields, env: PreviewEnv) => ActionPreview {
  return (input, env) => {
    previewCompanyScope(env.companyId, contract);
    return {
      title: `Новий товар: ${input.name}`,
      lines: [
        { label: CATALOG_NAME_LABEL, value: input.name },
        {
          label: PRODUCT_PRICE_LABEL,
          value: formatMoneyMinor(input.basePriceMinor, input.currency),
        },
        ...input.variants.map((variant) => ({
          label: variantLineLabel(variant.name),
          value: overridePrice(variant.basePriceMinor, variant.currency),
        })),
      ],
    };
  };
}

export function updateProductPreview(
  contract: Contract,
): (input: UpdateProductFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadProduct(env, companyId, input.productId);
    return {
      title: `Змінити товар: ${stored.name}`,
      lines: changeLines([
        ...(input.name === undefined
          ? []
          : [changeLine(CATALOG_NAME_LABEL, stored.name, input.name)]),
        ...(input.basePriceMinor === undefined || input.currency === undefined
          ? []
          : [
              changeLine(
                PRODUCT_PRICE_LABEL,
                formatMoneyMinor(
                  moneyToCanonical(stored.basePriceMinor),
                  stored.currency,
                ),
                formatMoneyMinor(input.basePriceMinor, input.currency),
              ),
            ]),
      ]),
    };
  };
}

export function createVariantPreview(
  contract: Contract,
): (input: CreateVariantFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const product = await loadProduct(env, companyId, input.productId);
    return {
      title: `Новий варіант: ${input.name}`,
      lines: [
        { label: CATALOG_PRODUCT_LABEL, value: product.name },
        { label: CATALOG_NAME_LABEL, value: input.name },
        {
          label: VARIANT_PRICE_LABEL,
          value: overridePrice(input.basePriceMinor, input.currency),
        },
      ],
    };
  };
}

export function updateVariantPreview(
  contract: Contract,
): (input: UpdateVariantFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadVariant(
      env,
      companyId,
      input.variantId,
      input.productId,
    );
    const changed: ActionPreviewLine[] = [];
    if (input.name !== undefined) {
      changed.push(changeLine(CATALOG_NAME_LABEL, stored.name, input.name));
    }
    if (input.basePriceMinor !== undefined) {
      changed.push(
        changeLine(
          VARIANT_PRICE_LABEL,
          storedOverridePrice(stored.basePriceMinor, stored.currency),
          overridePrice(input.basePriceMinor, input.currency),
        ),
      );
    }
    return {
      title: `Змінити варіант: ${stored.name}`,
      lines: [
        { label: CATALOG_PRODUCT_LABEL, value: stored.productName },
        ...changeLines(changed),
      ],
    };
  };
}

export function productStatusPreview(
  contract: Contract,
  subject: string,
  status: ProductStatus,
): (
  input: { readonly productId: string },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadProduct(env, companyId, input.productId);
    return {
      title: `${subject}: ${stored.name}`,
      lines: [
        changeLine(
          CATALOG_STATUS_LABEL,
          statusLabel(stored.status),
          STATUS_LABELS[status],
        ),
      ],
    };
  };
}

export function variantStatusPreview(
  contract: Contract,
  subject: string,
  status: ProductStatus,
): (
  input: { readonly variantId: string },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadVariant(env, companyId, input.variantId);
    return {
      title: `${subject}: ${stored.name}`,
      lines: [
        { label: CATALOG_PRODUCT_LABEL, value: stored.productName },
        changeLine(
          CATALOG_STATUS_LABEL,
          statusLabel(stored.status),
          STATUS_LABELS[status],
        ),
      ],
    };
  };
}
