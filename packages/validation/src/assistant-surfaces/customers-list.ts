/**
 * Unlocalized customers-list surface parse (SHO-472). Binds
 * `customers_list_customers` compact façade output. Do not walk
 * customer ids into entity cards. Do not import `@showzy/ai`.
 *
 * Row cap is a literal copy of CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT
 * (façade max 7). This zod-only leaf must not depend on a module
 * contract or packages/ai to read that number. packages/ai owns the
 * equality guard. Do not derive this by adding a forbidden dependency.
 */
import {
  assistantCollectionDescriptor,
  capCollectionRows,
  type AssistantCollectionColumn,
  type AssistantCollectionDescriptor,
} from "./collection.js";
import {
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
  assistantCustomerEditorScreenHref,
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isRecord,
  lastSuccessfulResult,
  unwrapToolOutput,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const ASSISTANT_CUSTOMERS_LIST_ROW_MAX = 7;

export const CUSTOMERS_LIST_CUSTOMERS_TOOL = "customers_list_customers";

export const CUSTOMERS_LIST_SURFACE_TOOLS = [
  CUSTOMERS_LIST_CUSTOMERS_TOOL,
] as const;

export const CUSTOMERS_LIST_ACTION_NAME = "customers.listCustomers";

export const CUSTOMERS_LIST_PROMPT_LINE =
  "After customers_list_customers, the UI already shows the customers list card. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const CUSTOMERS_LIST_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const CUSTOMERS_LIST_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
  ];

export type AssistantCustomersListRowData = {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string | null;
  readonly groupId: string | null;
  readonly priceListId: string | null;
};

export type AssistantCustomersListData = {
  readonly kind: "customers-list";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantCustomersListRowData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly collection: AssistantCollectionDescriptor;
};

function optionalText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

function parseCustomerRow(row: unknown): AssistantCustomersListRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const customerId = row["id"];
  if (typeof customerId !== "string" || customerId.length === 0) {
    return null;
  }
  const name = typeof row["name"] === "string" ? row["name"] : "";
  return {
    customerId,
    name,
    phone: optionalText(row["phone"]),
    email: optionalText(row["email"]),
    status: optionalText(row["status"]),
    groupId: optionalText(row["groupId"]),
    priceListId: optionalText(row["priceListId"]),
  };
}

function pageItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
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

function collectionRowFromCustomer(
  row: AssistantCustomersListRowData,
): AssistantCollectionDescriptor["rows"][number] {
  return {
    id: row.customerId,
    title: row.name,
    badge: row.status,
    meta: null,
    cells: [],
    href: assistantCustomerEditorScreenHref(row.customerId),
  };
}

/**
 * One customers-list surface when a live `customers_list_customers`
 * result is present. Returns null when there is no successful page.
 */
export function parseCustomersListSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantCustomersListData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === CUSTOMERS_LIST_CUSTOMERS_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantCustomersListRowData[] = [];
  for (const row of pageItems(payload)) {
    const parsed = parseCustomerRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(
    parsedRows,
    ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
  );
  const nextCursor = pageNextCursor(payload);
  const hasMore = clipped || nextCursor !== null || capped.truncatedByCap;
  return {
    kind: "customers-list",
    destination: resolveAssistantSurfaceDestination(
      CUSTOMERS_LIST_DESTINATION,
      ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
    ),
    rows: capped.rows,
    clipped,
    hasMore,
    nextCursor,
    collection: assistantCollectionDescriptor({
      columns: CUSTOMERS_LIST_COLLECTION_COLUMNS,
      rows: capped.rows.map(collectionRowFromCustomer),
      surface: "plain",
      rowCap: ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
      truncated: clipped || capped.truncatedByCap || nextCursor !== null,
    }),
  };
}
