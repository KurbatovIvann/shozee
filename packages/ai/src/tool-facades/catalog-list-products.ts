/**
 * Named staff-assistant tool over `catalog.listProducts` (SHO-357 / ADR-0033).
 *
 * Presentation adapter only: `execute("catalog.listProducts", canonical)`.
 * Do not add `catalog.listProductsForAssistant`. Do not flatten
 * `list-products.contract.ts`. Do not rebuild the public list as `kind`.
 */
import {
  LIST_PRODUCTS_CURSOR_MAX,
  LIST_PRODUCTS_DEFAULT_LIMIT,
  LIST_PRODUCTS_MAX_LIMIT,
  LIST_PRODUCTS_QUERY_MAX,
} from "@showzy/catalog/contract";
import type { ActionContract } from "@showzy/core/contract";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";

export const CATALOG_LIST_PRODUCTS_ACTION_NAME = "catalog.listProducts";
export const CATALOG_LIST_PRODUCTS_TOOL_NAME = "catalog_list_products";

export const CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT = LIST_PRODUCTS_DEFAULT_LIMIT;
export const CATALOG_LIST_PRODUCTS_MAX_LIMIT = LIST_PRODUCTS_MAX_LIMIT;
export const CATALOG_LIST_PRODUCTS_QUERY_MAX = LIST_PRODUCTS_QUERY_MAX;
export const CATALOG_LIST_PRODUCTS_CURSOR_MAX = LIST_PRODUCTS_CURSOR_MAX;

const catalogListProductsStatusSchema = z.enum(["active", "archived", "all"]);

export const catalogListProductsInputSchema = z.strictObject({
  status: catalogListProductsStatusSchema.default("active"),
  query: z
    .string()
    .trim()
    .min(1)
    .max(CATALOG_LIST_PRODUCTS_QUERY_MAX)
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CATALOG_LIST_PRODUCTS_MAX_LIMIT)
    .default(CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(CATALOG_LIST_PRODUCTS_CURSOR_MAX).optional(),
});

export type CatalogListProductsFacadeInput = z.output<
  typeof catalogListProductsInputSchema
>;

const CATALOG_LIST_PRODUCTS_DESCRIPTION =
  'Compact product page in the active company: id, name, basePriceMinor, currency, status, variantCount, and nextCursor. Default status is active; pass archived or all to include archived rows. Optional case-insensitive name query. Put people and product names in nominative (Катя Самбука, Наполеон) — not the inflected form from the staff sentence (Каті Самбуки, наполеона). Pass only the name or query, not the whole utterance («замовлення для …»). One empty page is not "does not exist": retry with nominative and/or the last-name or product-name stem before telling the staff member nobody or nothing matches. Optional cursor pages forward. Default page size is 20, cap 50. Does not return image file ids or timestamps — use these base prices to fill a price-list markup. Do not call catalog.getProduct in a loop and do not page just to recover prices.';

export function mapCatalogListProductsInput(
  input: CatalogListProductsFacadeInput,
): {
  readonly status: CatalogListProductsFacadeInput["status"];
  readonly query?: string;
  readonly limit: number;
  readonly cursor?: string;
} {
  return {
    status: input.status,
    ...(input.query !== undefined ? { query: input.query } : {}),
    limit: input.limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapCatalogListProductsCompactRow(row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  return {
    id: row["id"],
    name: row["name"],
    basePriceMinor: row["basePriceMinor"],
    currency: row["currency"],
    status: row["status"],
    variantCount: row["variantCount"],
  };
}

/**
 * Assistant view of `catalog.listProducts`. Drops `primaryImageFileId`,
 * `createdAt`, and `updatedAt` so clip cannot strip prices from a fat page.
 * Typed errors and confirmation payloads pass through unchanged.
 */
export function mapCatalogListProductsOutput(output: unknown): unknown {
  if (!isRecord(output) || !Array.isArray(output["items"])) {
    return output;
  }
  const nextCursor = output["nextCursor"];
  return {
    items: output["items"].map((row) => mapCatalogListProductsCompactRow(row)),
    nextCursor: nextCursor === undefined ? null : nextCursor,
  };
}

/**
 * One hot ToolSet entry that still executes the `catalog.listProducts`
 * registry name (audit, permissions, timeout unchanged).
 */
export function catalogListProductsFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [CATALOG_LIST_PRODUCTS_TOOL_NAME]: tool({
      description: CATALOG_LIST_PRODUCTS_DESCRIPTION,
      inputSchema: catalogListProductsInputSchema,
      execute: async (input, options) => {
        const parsed = catalogListProductsInputSchema.parse(input);
        const canonical = mapCatalogListProductsInput(parsed);
        const raw = await execute(
          CATALOG_LIST_PRODUCTS_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
        return mapCatalogListProductsOutput(raw);
      },
    }),
  };
}
