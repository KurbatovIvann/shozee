import {
  assistantCollectionDescriptor,
  capCollectionRows,
  type AssistantCollectionColumn,
  type AssistantCollectionDescriptor,
} from "./collection.js";
import {
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
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

export const ASSISTANT_CUSTOMER_GROUPS_ROW_MAX = 7;

export const CUSTOMER_GROUPS_LIST_TOOL = "customers_list_groups";

export const CUSTOMER_GROUPS_SURFACE_TOOLS = [
  CUSTOMER_GROUPS_LIST_TOOL,
] as const;

export const CUSTOMER_GROUPS_ACTION_NAME = "customers.listGroups";

export const CUSTOMER_GROUPS_PROMPT_LINE =
  "After customers.listGroups, the UI already shows the customer groups card with the client count per group. Reply with a short product-language summary. Do not dump a markdown table of the rows.";

export const CUSTOMER_GROUPS_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export const CUSTOMER_GROUPS_COLLECTION_COLUMNS: readonly AssistantCollectionColumn[] =
  [
    {
      id: "title",
      label: "",
      width: "flex",
      alignment: "start",
    },
  ];

export type AssistantCustomerGroupsRowData = {
  readonly groupId: string;
  readonly name: string;
  readonly memberCount: number | null;
};

export type AssistantCustomerGroupsData = {
  readonly kind: "customer-groups";
  readonly destination: AssistantSurfaceDestination;
  readonly rows: readonly AssistantCustomerGroupsRowData[];
  readonly clipped: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly collection: AssistantCollectionDescriptor;
};

function parseGroupRow(row: unknown): AssistantCustomerGroupsRowData | null {
  if (!isRecord(row)) {
    return null;
  }
  const groupId = textOrNull(row["id"]);
  if (groupId === null) {
    return null;
  }
  return {
    groupId,
    name: textOrNull(row["name"]) ?? "",
    memberCount: wholeCountOrNull(row["memberCount"]),
  };
}

export function parseCustomerGroupsSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantCustomerGroupsData | null {
  const pageResult = lastSuccessfulResult(
    results,
    (name) => name === CUSTOMER_GROUPS_LIST_TOOL,
  );
  if (pageResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(pageResult.output);
  const parsedRows: AssistantCustomerGroupsRowData[] = [];
  for (const row of assistantPageItems(payload)) {
    const parsed = parseGroupRow(row);
    if (parsed !== null) {
      parsedRows.push(parsed);
    }
  }
  const capped = capCollectionRows(
    parsedRows,
    ASSISTANT_CUSTOMER_GROUPS_ROW_MAX,
  );
  const nextCursor = assistantPageNextCursor(payload);
  const truncated = clipped || capped.truncatedByCap || nextCursor !== null;
  return {
    kind: "customer-groups",
    destination: resolveAssistantSurfaceDestination(
      CUSTOMER_GROUPS_DESTINATION,
      ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
    ),
    rows: capped.rows,
    clipped,
    hasMore: truncated,
    nextCursor,
    collection: assistantCollectionDescriptor({
      columns: CUSTOMER_GROUPS_COLLECTION_COLUMNS,
      surface: "plain",
      rowCap: ASSISTANT_CUSTOMER_GROUPS_ROW_MAX,
      truncated,
    }),
  };
}
