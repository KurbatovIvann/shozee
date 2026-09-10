/**
 * Named staff-assistant tool over `orders.create` (SHO-359 / ADR-0033).
 *
 * Presentation adapter only: `execute("orders.create", canonical)`.
 * Do not add `orders.createForAssistant`. Do not flatten
 * `create.contract.ts`. Do not hot-load unrelated writes.
 */
import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
} from "@showzy/orders/contract";
import { ORDER_ENTITY_PROMPT_LINE } from "@showzy/validation/assistant-surfaces";
import { ENTITY_REF_QUERY_MAX } from "@showzy/validation/entity-ref";
import {
  DECIMAL_QUANTITY_MESSAGE,
  isDecimalQuantityString,
  quantityMilliWireSchema,
} from "@showzy/validation/money";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";

export const ORDERS_CREATE_ACTION_NAME = "orders.create";
export const ORDERS_CREATE_TOOL_NAME = "orders_create";

export { CREATE_ORDER_COMMENT_MAX, CREATE_ORDER_MAX_ITEMS };

export const ORDERS_CREATE_QUERY_MAX = ENTITY_REF_QUERY_MAX;

const CUSTOMER_LOCATOR_MESSAGE =
  "Provide exactly one of customerId or customerQuery.";
const PRODUCT_LOCATOR_MESSAGE =
  "Provide exactly one of productId or productQuery on each line.";
const VARIANT_LOCATOR_MESSAGE =
  "Provide at most one of variantId or variantQuery on each line.";
const QUANTITY_XOR_MESSAGE =
  "Provide exactly one of quantityMilli or quantityDecimal on each line.";

const queryField = z
  .string()
  .trim()
  .min(1)
  .max(ORDERS_CREATE_QUERY_MAX)
  .optional();

const quantityMilliField = quantityMilliWireSchema.optional();

const quantityDecimalField = z
  .string()
  .refine(isDecimalQuantityString, { message: DECIMAL_QUANTITY_MESSAGE })
  .optional();

export const ordersCreateItemSchema = z.strictObject({
  productId: z.uuid().optional(),
  productQuery: queryField,
  variantId: z.uuid().optional(),
  variantQuery: queryField,
  quantityMilli: quantityMilliField,
  quantityDecimal: quantityDecimalField,
});

function hasExactlyOne(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (left !== undefined) !== (right !== undefined);
}

function hasAtMostOne(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return !(left !== undefined && right !== undefined);
}

export const ordersCreateInputSchema = z
  .strictObject({
    customerId: z.uuid().optional(),
    customerQuery: queryField,
    items: z.array(ordersCreateItemSchema).min(1).max(CREATE_ORDER_MAX_ITEMS),
    comment: z.string().max(CREATE_ORDER_COMMENT_MAX).optional(),
  })
  .refine((input) => hasExactlyOne(input.customerId, input.customerQuery), {
    message: CUSTOMER_LOCATOR_MESSAGE,
  })
  .refine(
    (input) =>
      input.items.every((item) =>
        hasExactlyOne(item.productId, item.productQuery),
      ),
    { message: PRODUCT_LOCATOR_MESSAGE },
  )
  .refine(
    (input) =>
      input.items.every((item) =>
        hasAtMostOne(item.variantId, item.variantQuery),
      ),
    { message: VARIANT_LOCATOR_MESSAGE },
  )
  .refine(
    (input) =>
      input.items.every((item) =>
        hasExactlyOne(item.quantityMilli, item.quantityDecimal),
      ),
    { message: QUANTITY_XOR_MESSAGE },
  );

export type OrdersCreateFacadeInput = z.output<typeof ordersCreateInputSchema>;

export type OrdersCreateMappedEntityRef =
  | { readonly by: "id"; readonly id: string }
  | { readonly by: "query"; readonly value: string };

export type OrdersCreateMappedQuantity =
  { readonly milli: string } | { readonly decimal: string };

export type OrdersCreateMappedVariantSelection =
  | { readonly kind: "unspecified" }
  | {
      readonly kind: "reference";
      readonly ref: OrdersCreateMappedEntityRef;
    };

export type OrdersCreateMappedItem = {
  readonly product: OrdersCreateMappedEntityRef;
  readonly quantity: OrdersCreateMappedQuantity;
  readonly variantSelection: OrdersCreateMappedVariantSelection;
};

export type OrdersCreateMappedInput = {
  readonly customer: OrdersCreateMappedEntityRef;
  readonly items: readonly OrdersCreateMappedItem[];
  readonly comment?: string;
};

const ORDERS_CREATE_DESCRIPTION = `Create a staff-intake order in the active company. Pass exactly one of customerId or customerQuery (unique name, phone, or email). Each line: exactly one of productId or productQuery, optional variantId or variantQuery (not both), and exactly one of quantityMilli or quantityDecimal (scale 3, for example 1.5). Optional comment. Do not send EntityRef { by, id } / { by, value } unions. Do not refuse because EntityRef is missing. Pass the staff member's own words as the query and let this tool resolve them. A name matching more than one record returns CONFLICT carrying the candidates, which the staff member taps — that is the intended path, not a failure to avoid. Do not list the catalog or the customers first to find out whether a name is ambiguous, and do not ask which one they meant: you cannot show a list to tap and this tool can. Never guess between candidates yourself. Creating a customer, group, or price list is a separate write; this tool only creates the order. ${ORDER_ENTITY_PROMPT_LINE}`;

function mapRequiredEntityRef(
  id: string | undefined,
  query: string | undefined,
): OrdersCreateMappedEntityRef {
  if (id !== undefined) {
    return { by: "id", id };
  }
  if (query !== undefined) {
    return { by: "query", value: query };
  }
  throw new CoreInvariantError(
    "orders.create façade locator missing after refine",
  );
}

/**
 * Absence of a variant locator is unspecified, never `base`. Mapping omit
 * to `base` would sell the parent of a variable product.
 */
function mapVariantSelection(
  id: string | undefined,
  query: string | undefined,
): OrdersCreateMappedVariantSelection {
  if (id !== undefined) {
    return { kind: "reference", ref: { by: "id", id } };
  }
  if (query !== undefined) {
    return { kind: "reference", ref: { by: "query", value: query } };
  }
  return { kind: "unspecified" };
}

function mapQuantity(
  milli: string | undefined,
  decimal: string | undefined,
): OrdersCreateMappedQuantity {
  if (milli !== undefined) {
    return { milli };
  }
  if (decimal !== undefined) {
    return { decimal };
  }
  throw new CoreInvariantError(
    "orders.create façade quantity missing after refine",
  );
}

function mapItem(
  item: OrdersCreateFacadeInput["items"][number],
): OrdersCreateMappedItem {
  return {
    product: mapRequiredEntityRef(item.productId, item.productQuery),
    variantSelection: mapVariantSelection(item.variantId, item.variantQuery),
    quantity: mapQuantity(item.quantityMilli, item.quantityDecimal),
  };
}

export function mapOrdersCreateInput(
  input: OrdersCreateFacadeInput,
): OrdersCreateMappedInput {
  return {
    customer: mapRequiredEntityRef(input.customerId, input.customerQuery),
    items: input.items.map((item) => mapItem(item)),
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

/**
 * One hot ToolSet entry that still executes the `orders.create` registry
 * name (audit, permissions, timeout, idempotency unchanged).
 */
export function ordersCreateFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [ORDERS_CREATE_TOOL_NAME]: tool({
      description: ORDERS_CREATE_DESCRIPTION,
      inputSchema: ordersCreateInputSchema,
      execute: async (input, options) => {
        const parsed = ordersCreateInputSchema.parse(input);
        const canonical = mapOrdersCreateInput(parsed);
        return execute(
          ORDERS_CREATE_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
      },
    }),
  };
}
