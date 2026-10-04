import {
  assistantCollectionDescriptor,
  capCollectionRows,
  type AssistantCollectionColumn,
  type AssistantCollectionDescriptor,
} from "./collection.js";
import {
  ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  assistantPageItems,
  assistantPageNextCursor,
  isRecord,
  lastSuccessfulResult,
  moneyMinorFromFields,
  textOrNull,
  unwrapToolOutput,
  wholeCountOrNull,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const ASSISTANT_PRODUCTS_LIST_ROW_MAX = 7;

export const PRODUCTS_LIST_PRODUCTS_TOOL = "catalog_list_products";

export const PRODUCTS_LIST_SURFACE_TOOLS = [
  PRODUCTS_LIST_PRODUCTS_TOOL,
] as const;

export const PRODUCTS_LIST_ACTION_NAME = "catalog.listProducts";

export const PRODUCTS_LIST_PROMPT_LINE =
  "After catalog_list_products, the UI already shows the products list card with name, base price and variant count. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const PRODUCTS_LIST_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const PRODUCTS_LIST_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
    {
      id: "basePrice",
      label: "",
      width: "auto",
      alignment: "end",
    },
  ];

export type AssistantProductsListRowData = {
  readonly productId: string;
  readonly name: string;
  readonly basePrice: AssistantMoneyMinor | null;
  readonly status: string | null;
  readonly variantCount: number | null;
};

export type AssistantProductsListData = {
  readonly kind: "products-list";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantProductsListRowData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly collection: AssistantCollectionDescriptor;
};

function parseProductRow(row: unknown): AssistantProductsListRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const productId = textOrNull(row["id"]);
  if (productId === null) {
    return null;
  }
  return {
    productId,
    name: textOrNull(row["name"]) ?? "",
    basePrice: moneyMinorFromFields(row["basePriceMinor"], row["currency"]),
    status: textOrNull(row["status"]),
    variantCount: wholeCountOrNull(row["variantCount"]),
  };
}

export function parseProductsListSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantProductsListData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === PRODUCTS_LIST_PRODUCTS_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantProductsListRowData[] = [];
  for (const row of assistantPageItems(payload)) {
    const parsed = parseProductRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(parsedRows, ASSISTANT_PRODUCTS_LIST_ROW_MAX);
  const nextCursor = assistantPageNextCursor(payload);
  const truncated = clipped || capped.truncatedByCap || nextCursor !== null;
  return {
    kind: "products-list",
    destination: resolveAssistantSurfaceDestination(
      PRODUCTS_LIST_DESTINATION,
      ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
    ),
    rows: capped.rows,
    clipped,
    hasMore: truncated,
    nextCursor,
    collection: assistantCollectionDescriptor({
      columns: PRODUCTS_LIST_COLLECTION_COLUMNS,
      surface: "plain",
      rowCap: ASSISTANT_PRODUCTS_LIST_ROW_MAX,
      truncated,
    }),
  };
}
