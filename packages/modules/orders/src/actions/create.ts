import { resolveLineReferences } from "@showzy/catalog";
import { getCompany } from "@showzy/companies";
import { implementAction } from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import { resolveCustomerReference } from "@showzy/customers";
import { createAuditTarget, pickString } from "@showzy/module-kit/audit-target";
import { resolveProductPrices } from "@showzy/pricing";
import { z } from "zod";

import { createStaffOrder } from "../services/create-order.js";
import { quantityInputToMilli } from "../services/quantity.js";
import {
  DUPLICATE_ORDER_LINE_MESSAGE,
  createOrderContract,
  type CreateOrderItemInput,
} from "./create.contract.js";

const createOrderAuditTarget = createAuditTarget({
  type: "order",
  fallback: "uncreated",
  steps: [
    {
      source: "output",
      schema: z.object({ orderId: z.string() }),
      pick: (data) => pickString("orderId", data),
    },
  ],
});

/**
 * Map a create line onto catalog.resolveLineReferences (SHO-406).
 * variantSelection passes through. Legacy variant becomes reference.
 * Neither field is omitted so catalog unspecified — never coerced to base.
 */
function toCatalogLineInput(item: CreateOrderItemInput): {
  product: CreateOrderItemInput["product"];
  variantSelection?: CreateOrderItemInput["variantSelection"];
} {
  if (item.variantSelection !== undefined) {
    return {
      product: item.product,
      variantSelection: item.variantSelection,
    };
  }
  if (item.variant !== undefined) {
    return {
      product: item.product,
      variantSelection: { kind: "reference", ref: item.variant },
    };
  }
  return { product: item.product };
}

function canonicalLineKey(productId: string, variantId: string | null): string {
  return `${productId}\0${variantId ?? ""}`;
}

function assertUniqueCanonicalLines(
  items: readonly {
    readonly productId: string;
    readonly variantId: string | null;
  }[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = canonicalLineKey(item.productId, item.variantId);
    if (seen.has(key)) {
      const issue: z.core.$ZodIssue = {
        code: "custom",
        path: ["items"],
        message: DUPLICATE_ORDER_LINE_MESSAGE,
        input: items,
      };
      throw new ValidationError([issue], DUPLICATE_ORDER_LINE_MESSAGE);
    }
    seen.add(key);
  }
}

export const createOrder = implementAction(createOrderContract, {
  handler: async (input, ctx) => {
    const customer = await ctx.call(resolveCustomerReference, input.customer);
    const catalog = await ctx.call(resolveLineReferences, {
      lines: input.items.map((item) => toCatalogLineInput(item)),
    });
    if (catalog.lines.length !== input.items.length) {
      throw new CoreInvariantError(
        "catalog.resolveLineReferences returned a different line count than create input",
      );
    }

    const items = input.items.map((item, index) => {
      const line = catalog.lines[index];
      if (line === undefined) {
        throw new CoreInvariantError(
          "catalog.resolveLineReferences line zip went out of range",
        );
      }
      return {
        productId: line.productId,
        variantId: line.variantId,
        quantityMilli: quantityInputToMilli(item.quantity),
        productName: line.productName,
        variantName: line.variantName,
      };
    });
    assertUniqueCanonicalLines(items);

    const company = await ctx.call(getCompany, {});
    const priced = await ctx.call(resolveProductPrices, {
      items: items.map((item) => ({
        productId: item.productId,
        ...(item.variantId === null ? {} : { variantId: item.variantId }),
      })),
      customerId: customer.customerId,
    });

    const customerNameSnapshot = customer.name.trim();
    if (customerNameSnapshot.length === 0) {
      throw new CoreInvariantError(
        "orders.create customer name snapshot is empty",
      );
    }

    return createStaffOrder({
      ctx,
      customerId: customer.customerId,
      customerNameSnapshot,
      items,
      comment: input.comment,
      numberingPrefix: company.prefix,
      prices: priced.prices,
    });
  },
  auditTarget: createOrderAuditTarget,
});
