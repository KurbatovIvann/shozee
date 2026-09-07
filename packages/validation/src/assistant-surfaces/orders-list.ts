/**
 * Unlocalized orders-list surface parse (SHO-456). Binds
 * `orders_list_page` plus same-turn `orders_list_counts` chips. Do not
 * walk `items[].orderId` into entity surfaces.
 */
import {
  assistantCollectionDescriptor,
  capCollectionRows,
  type AssistantCollectionColumn,
  type AssistantCollectionDescriptor,
} from "./collection.js";
import {
  ASSISTANT_ORDERS_LIST_SCREEN_HREF,
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  customerNameSnapshotFromPayload,
  isRecord,
  lastSuccessfulResult,
  moneyMinorFromFields,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

/**
 * Named façade page cap (SHO-403). Literal copy of
 * LIST_ORDERS_SUMMARY_MAX_LIMIT (façade alias
 * ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT). This zod-only leaf must not
 * depend on a module contract or packages/ai to read that number.
 * packages/ai owns the equality guard (SHO-462). Do not derive this
 * by adding a forbidden dependency.
 */
export const ASSISTANT_ORDERS_LIST_ROW_MAX = 50;

export const ORDERS_LIST_PAGE_TOOL = "orders_list_page";
export const ORDERS_LIST_COUNTS_TOOL = "orders_list_counts";

export const ORDERS_LIST_SURFACE_TOOLS = [
  ORDERS_LIST_PAGE_TOOL,
  ORDERS_LIST_COUNTS_TOOL,
] as const;

export const ORDERS_LIST_ACTION_NAME = "orders.list";

export const ORDERS_LIST_PROMPT_LINE =
  "After orders_list_page (chips from same-turn orders_list_counts), the UI already shows the orders list card. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const ORDERS_LIST_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantOrdersListRowData = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerNameSnapshot: string | null;
  readonly status: string | null;
  readonly itemCount: number | null;
  readonly createdAt: string | null;
  readonly total: AssistantMoneyMinor | null;
};

export type AssistantOrdersListChipData = {
  readonly status: string;
  readonly orderCount: number;
};

export const ORDERS_LIST_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
    {
      id: "total",
      label: "",
      width: "auto",
      alignment: "end",
    },
  ];

export type AssistantOrdersListData = {
  readonly kind: "orders-list";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantOrdersListRowData[];
  readonly chips: readonly AssistantOrdersListChipData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly customerMatchTruncated: boolean;
  readonly collection: AssistantCollectionDescriptor;
};

function parseListRow(row: unknown): AssistantOrdersListRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const orderId = row["orderId"];
  if (typeof orderId !== "string" || orderId.length === 0) {
    return null;
  }
  const orderNumber =
    typeof row["orderNumber"] === "string" ? row["orderNumber"] : "";
  const status = typeof row["status"] === "string" ? row["status"] : null;
  const itemCount =
    typeof row["itemCount"] === "number" ? row["itemCount"] : null;
  const createdAtRaw = row["createdAt"];
  const createdAt =
    typeof createdAtRaw === "string" && createdAtRaw.length > 0
      ? createdAtRaw
      : null;
  return {
    orderId,
    orderNumber,
    customerNameSnapshot: customerNameSnapshotFromPayload(row),
    status,
    itemCount,
    createdAt,
    total: moneyMinorFromFields(row["totalGrossMinor"], row["currency"]),
  };
}

function statusChipsFromCounts(
  output: unknown,
): readonly AssistantOrdersListChipData[] {
  const { payload } = unwrapToolOutput(output);
  if (!isRecord(payload) || payload["kind"] !== "aggregate") {
    return [];
  }
  const buckets = payload["buckets"];
  if (!Array.isArray(buckets)) {
    return [];
  }
  const chips: AssistantOrdersListChipData[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity) || identity["kind"] !== "status") {
      continue;
    }
    const status = identity["status"];
    if (typeof status !== "string" || status.length === 0 || seen.has(status)) {
      continue;
    }
    seen.add(status);
    const orderCount = bucket["orderCount"];
    chips.push({
      status,
      orderCount: typeof orderCount === "number" ? orderCount : 0,
    });
  }
  return chips;
}

function pageItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload["rows"])) {
    return payload["rows"];
  }
  const items = payload["items"];
  return Array.isArray(items) ? items : [];
}

function pageNextCursor(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const cursor = payload["nextCursor"];
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

function pageHasMore(payload: unknown, clipped: boolean): boolean {
  if (clipped) {
    return true;
  }
  if (isRecord(payload) && typeof payload["hasMore"] === "boolean") {
    return payload["hasMore"];
  }
  return pageNextCursor(payload) !== null;
}

function pageCustomerMatchTruncated(payload: unknown): boolean {
  return isRecord(payload) && payload["customerMatchTruncated"] === true;
}

/**
 * One list surface when a live `orders_list_page` result is present.
 * Chips come from same-turn `orders_list_counts`. Returns null when there
 * is no successful page — counts-only is the aggregate kind.
 */
export function parseOrdersListSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantOrdersListData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === ORDERS_LIST_PAGE_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const countsResult = lastSuccessfulResult(
    results,
    (name) => name === ORDERS_LIST_COUNTS_TOOL,
  );
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantOrdersListRowData[] = [];
  for (const row of pageItems(payload)) {
    const parsed = parseListRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(parsedRows, ASSISTANT_ORDERS_LIST_ROW_MAX);
  const hasMore = pageHasMore(payload, clipped);
  return {
    kind: "orders-list",
    destination: resolveAssistantSurfaceDestination(
      ORDERS_LIST_DESTINATION,
      ASSISTANT_ORDERS_LIST_SCREEN_HREF,
    ),
    rows: capped.rows,
    chips:
      countsResult === null ? [] : statusChipsFromCounts(countsResult.output),
    clipped,
    hasMore,
    nextCursor: pageNextCursor(payload),
    customerMatchTruncated: pageCustomerMatchTruncated(payload),
    collection: assistantCollectionDescriptor({
      columns: ORDERS_LIST_COLLECTION_COLUMNS,
      surface: "plain",
      rowCap: ASSISTANT_ORDERS_LIST_ROW_MAX,
      truncated: clipped || hasMore || capped.truncatedByCap,
    }),
  };
}
