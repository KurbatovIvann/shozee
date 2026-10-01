import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";
import {
  EXACTLY_ONE_REFERENCE_MESSAGE,
  entityLookupQuerySchema,
  nearestChoiceFromError,
} from "./entity-lookup.js";

export const CATALOG_GET_PRODUCT_ACTION_NAME = "catalog.getProduct";
export const CATALOG_GET_PRODUCT_TOOL_NAME = "catalog_get_product";

export const catalogGetProductInputSchema = z
  .strictObject({
    productId: z.uuid().optional(),
    productQuery: entityLookupQuerySchema.optional(),
  })
  .refine(
    (input) =>
      (input.productId === undefined) !== (input.productQuery === undefined),
    { message: EXACTLY_ONE_REFERENCE_MESSAGE },
  );

export type CatalogGetProductFacadeInput = z.output<
  typeof catalogGetProductInputSchema
>;

const CATALOG_GET_PRODUCT_DESCRIPTION =
  "One product in the active company: id, name, basePriceMinor, currency, status, every variant (archived included, each with its own status and nullable base-price override) and the ordered image fileId list. Pass productId for a known id, or productQuery with a product name. «Знайди наполеон» means this tool, not the list: a plural («покажи товари», «усі продукти») or a filter (status, archived, a price-list pass) means catalog_list_products. Put the name in nominative (Наполеон) — not the inflected form from the staff sentence (наполеона). Pass only the product name, not the whole utterance. A unique match returns that product, variants and all — an archived product and a product with no active variants open like any other. Several matches ask the staff member which one. Nothing matching offers the nearest products and creating a new one. Missing or foreign-company products fail with not-found. This action never returns image URLs or object keys.";

function canonicalInput(
  input: CatalogGetProductFacadeInput,
): Record<string, string> {
  if (input.productId !== undefined) {
    return { productId: input.productId };
  }
  if (input.productQuery !== undefined) {
    return { productQuery: input.productQuery };
  }
  throw new CoreInvariantError(
    `${CATALOG_GET_PRODUCT_TOOL_NAME} input carries neither productId nor productQuery`,
  );
}

export function catalogGetProductFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [CATALOG_GET_PRODUCT_TOOL_NAME]: tool({
      description: CATALOG_GET_PRODUCT_DESCRIPTION,
      inputSchema: catalogGetProductInputSchema,
      execute: async (input, options) => {
        const parsed = catalogGetProductInputSchema.parse(input);
        try {
          return await execute(
            CATALOG_GET_PRODUCT_ACTION_NAME,
            contract.input.parse(canonicalInput(parsed)),
            { toolCallId: options.toolCallId },
          );
        } catch (error) {
          if (parsed.productQuery === undefined) {
            throw error;
          }
          throw (
            nearestChoiceFromError(error, {
              kind: "product",
              query: parsed.productQuery,
            }) ?? error
          );
        }
      },
    }),
  };
}
