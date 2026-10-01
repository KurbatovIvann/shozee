import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";
import {
  EntityLookupConflictError,
  catalogPickerConflictExtrasFromError,
} from "../choice.js";
import {
  EXACTLY_ONE_REFERENCE_MESSAGE,
  entityLookupQuerySchema,
  isNotFound,
  isRecord,
  nothingMatchedConflict,
} from "./entity-lookup.js";

export const CATALOG_GET_PRODUCT_ACTION_NAME = "catalog.getProduct";
export const CATALOG_GET_PRODUCT_TOOL_NAME = "catalog_get_product";

export const CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME =
  "catalog.resolveLineReferences";

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
  "One product in the active company: id, name, basePriceMinor, currency, status, every variant (archived included, each with its own status and nullable base-price override) and the ordered image fileId list. Pass productId for a known id, or productQuery with a product name. «Знайди наполеон» means this tool, not the list: a plural («покажи товари», «усі продукти») or a filter (status, archived, a price-list pass) means catalog_list_products. Put the name in nominative (Наполеон) — not the inflected form from the staff sentence (наполеона). Pass only the product name, not the whole utterance. A unique match returns that product, variants and all. Several matches ask the staff member which one. Nothing matching offers creating a new product. Missing or foreign-company products fail with not-found. This action never returns image URLs or object keys.";

function productIdFromResolvedLines(resolved: unknown): string {
  const lines = isRecord(resolved) ? resolved["lines"] : undefined;
  const first = Array.isArray(lines) ? (lines[0] as unknown) : undefined;
  const productId = isRecord(first) ? first["productId"] : undefined;
  if (typeof productId !== "string") {
    throw new CoreInvariantError(
      `${CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME} returned no productId`,
    );
  }
  return productId;
}

async function resolveProductId(
  execute: ActionToolExecute,
  query: string,
  toolCallId: string,
): Promise<string> {
  try {
    const resolved = await execute(
      CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME,
      { lines: [{ product: { by: "query", value: query } }] },
      { toolCallId },
    );
    return productIdFromResolvedLines(resolved);
  } catch (error) {
    if (isNotFound(error)) {
      throw nothingMatchedConflict({ kind: "product", query });
    }
    const picker = catalogPickerConflictExtrasFromError(error);
    if (picker === undefined) {
      throw error;
    }
    if ("productId" in picker.target) {
      return picker.target.productId;
    }
    throw new EntityLookupConflictError({
      reason: picker.reason,
      target: { kind: "product", query },
      options: picker.options,
      optionsTruncated: picker.optionsTruncated,
      clientMessage: `Select a product matching "${query}".`,
    });
  }
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
        const productId =
          parsed.productId ??
          (await resolveProductId(
            execute,
            parsed.productQuery ?? "",
            options.toolCallId,
          ));
        return await execute(
          CATALOG_GET_PRODUCT_ACTION_NAME,
          contract.input.parse({ productId }),
          { toolCallId: options.toolCallId },
        );
      },
    }),
  };
}
