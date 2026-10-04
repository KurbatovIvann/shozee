import {
  assistantCollectionDescriptor,
  capCollectionRows,
  type AssistantCollectionColumn,
  type AssistantCollectionDescriptor,
} from "./collection.js";
import {
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  assistantPageItems,
  assistantPageNextCursor,
  isRecord,
  lastSuccessfulResult,
  textOrNull,
  unwrapToolOutput,
  wholeCountOrNull,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const ASSISTANT_PRICE_LISTS_ROW_MAX = 7;

export const PRICE_LISTS_PRICE_LISTS_TOOL = "pricing_list_price_lists";

export const PRICE_LISTS_SURFACE_TOOLS = [
  PRICE_LISTS_PRICE_LISTS_TOOL,
] as const;

export const PRICE_LISTS_ACTION_NAME = "pricing.listPriceLists";

export const PRICE_LISTS_PROMPT_LINE =
  "After pricing_list_price_lists, the UI already shows the price lists card with one marker per row (default, or inactive) and the entry count. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const PRICE_LISTS_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const PRICE_LISTS_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
  ];

export type AssistantPriceListsRowData = {
  readonly priceListId: string;
  readonly name: string;
  readonly isDefault: boolean | null;
  readonly isActive: boolean | null;
  readonly entryCount: number | null;
};

export type AssistantPriceListsData = {
  readonly kind: "price-lists";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantPriceListsRowData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly collection: AssistantCollectionDescriptor;
};

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parsePriceListRow(row: unknown): AssistantPriceListsRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const priceListId = textOrNull(row["id"]);
  if (priceListId === null) {
    return null;
  }
  return {
    priceListId,
    name: textOrNull(row["name"]) ?? "",
    isDefault: booleanOrNull(row["isDefault"]),
    isActive: booleanOrNull(row["isActive"]),
    entryCount: wholeCountOrNull(row["entryCount"]),
  };
}

export function parsePriceListsSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantPriceListsData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === PRICE_LISTS_PRICE_LISTS_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantPriceListsRowData[] = [];
  for (const row of assistantPageItems(payload)) {
    const parsed = parsePriceListRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(parsedRows, ASSISTANT_PRICE_LISTS_ROW_MAX);
  const nextCursor = assistantPageNextCursor(payload);
  const truncated = clipped || capped.truncatedByCap || nextCursor !== null;
  return {
    kind: "price-lists",
    destination: resolveAssistantSurfaceDestination(
      PRICE_LISTS_DESTINATION,
      ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    ),
    rows: capped.rows,
    clipped,
    hasMore: truncated,
    nextCursor,
    collection: assistantCollectionDescriptor({
      columns: PRICE_LISTS_COLLECTION_COLUMNS,
      surface: "plain",
      rowCap: ASSISTANT_PRICE_LISTS_ROW_MAX,
      truncated,
    }),
  };
}
