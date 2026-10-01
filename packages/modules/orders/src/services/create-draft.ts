import { resolveLineReferences } from "@showzy/catalog";
import type { CtxCall } from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import { resolveCustomerReference } from "@showzy/customers";
import { resolveProductPrices } from "@showzy/pricing";
import type { z } from "zod";

import {
  DUPLICATE_ORDER_LINE_MESSAGE,
  type CreateOrderItemInput,
  type createOrderInputSchema,
} from "../actions/create.contract.js";
import type {
  PersistedCreateLine,
  ResolvedOrderPrice,
} from "./create-order.js";
import { quantityInputToMilli } from "./quantity.js";

export type CreateOrderInput = z.output<typeof createOrderInputSchema>;

export interface CreateOrderDraft {
  readonly customerId: string;
  readonly customerNameSnapshot: string;
  readonly items: readonly PersistedCreateLine[];
  readonly prices: readonly ResolvedOrderPrice[];
}

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
  items: readonly PersistedCreateLine[],
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

export async function resolveCreateOrderDraft(
  call: CtxCall,
  input: CreateOrderInput,
): Promise<CreateOrderDraft> {
  const customer = await call(resolveCustomerReference, input.customer);
  const catalog = await call(resolveLineReferences, {
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

  const priced = await call(resolveProductPrices, {
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

  return {
    customerId: customer.customerId,
    customerNameSnapshot,
    items,
    prices: priced.prices,
  };
}
