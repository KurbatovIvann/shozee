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
  moneyMinorFromFields,
  textOrNull,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX = 7;

export const PRICE_LIST_ENTRIES_ENTRIES_TOOL = "pricing_listPriceListEntries";

export const PRICE_LIST_ENTRIES_SURFACE_TOOLS = [
  PRICE_LIST_ENTRIES_ENTRIES_TOOL,
] as const;

export const PRICE_LIST_ENTRIES_ACTION_NAME = "pricing.listPriceListEntries";

export const PRICE_LIST_ENTRIES_PROMPT_LINE =
  "After pricing_listPriceListEntries, the UI already shows the price list entries card with one row per entry, its variant marker and its price. The rows carry product ids, not product names, so name a product only from another tool result. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const PRICE_LIST_ENTRIES_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const PRICE_LIST_ENTRIES_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
    {
      id: "price",
      label: "",
      width: "auto",
      alignment: "end",
    },
  ];

export type AssistantPriceListEntriesRowData = {
  readonly entryId: string;
  readonly priceListId: string | null;
  readonly productId: string | null;
  readonly variantId: string | null;
  readonly price: AssistantMoneyMinor | null;
};

export type AssistantPriceListEntriesData = {
  readonly kind: "price-list-entries";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantPriceListEntriesRowData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly collection: AssistantCollectionDescriptor;
};

function parseEntryRow(row: unknown): AssistantPriceListEntriesRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const entryId = textOrNull(row["id"]);
  if (entryId === null) {
    return null;
  }
  return {
    entryId,
    priceListId: textOrNull(row["priceListId"]),
    productId: textOrNull(row["productId"]),
    variantId: textOrNull(row["variantId"]),
    price: moneyMinorFromFields(row["priceMinor"], row["currency"]),
  };
}

export function parsePriceListEntriesSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantPriceListEntriesData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === PRICE_LIST_ENTRIES_ENTRIES_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantPriceListEntriesRowData[] = [];
  for (const row of assistantPageItems(payload)) {
    const parsed = parseEntryRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(
    parsedRows,
    ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
  );
  const nextCursor = assistantPageNextCursor(payload);
  const truncated = clipped || capped.truncatedByCap || nextCursor !== null;
  return {
    kind: "price-list-entries",
    destination: resolveAssistantSurfaceDestination(
      PRICE_LIST_ENTRIES_DESTINATION,
      ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    ),
    rows: capped.rows,
    clipped,
    hasMore: truncated,
    nextCursor,
    collection: assistantCollectionDescriptor({
      columns: PRICE_LIST_ENTRIES_COLLECTION_COLUMNS,
      surface: "plain",
      rowCap: ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
      truncated,
    }),
  };
}
