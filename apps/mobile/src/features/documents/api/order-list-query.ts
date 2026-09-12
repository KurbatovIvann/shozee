import type { ContractClient } from "../../../api/client";
import { contractInfiniteQueryOptions } from "../../../api/query-options";
import { DOCUMENT_LOOKUP_PAGE_SIZE } from "../shared/document-caps";

export const LIST_ORDERS_ACTION = "orders.list";

type ShowzyClient = ContractClient;
export type ListOrdersOutput = Awaited<
  ReturnType<ShowzyClient["client"]["orders"]["list"]>
>;
export type ListOrdersSummaryPage = Extract<
  ListOrdersOutput,
  { kind: "page.summary" }
>;
export type DocumentOrderListItem = ListOrdersSummaryPage["items"][number];

export type DocumentOrdersListClient = {
  readonly client: {
    readonly orders: {
      readonly list: ShowzyClient["client"]["orders"]["list"];
    };
  };
};

export const DOCUMENT_ORDERS_LOOKUP_INPUT: {
  readonly kind: "page.summary";
  readonly filter: {
    readonly statuses: Array<
      "new" | "confirmed" | "in_progress" | "done" | "canceled"
    >;
  };
  readonly limit: number;
} = {
  kind: "page.summary",
  filter: { statuses: ["confirmed"] },
  limit: DOCUMENT_LOOKUP_PAGE_SIZE,
};

export type ListDocumentOrdersPageInput = {
  readonly kind: "page.summary";
  readonly filter: {
    readonly statuses: Array<
      "new" | "confirmed" | "in_progress" | "done" | "canceled"
    >;
    readonly query?: string;
  };
  readonly limit: number;
};

export function documentOrdersLookupInput(
  query: string | undefined,
): ListDocumentOrdersPageInput {
  return {
    ...DOCUMENT_ORDERS_LOOKUP_INPUT,
    filter: {
      ...DOCUMENT_ORDERS_LOOKUP_INPUT.filter,
      ...(query === undefined ? {} : { query }),
    },
  };
}

async function fetchDocumentOrdersPage(
  client: DocumentOrdersListClient,
  input: ListDocumentOrdersPageInput,
  cursor: string | null,
): Promise<ListOrdersSummaryPage> {
  const page = await client.client.orders.list({
    ...input,
    ...(cursor === null ? {} : { cursor }),
  });
  if (page.kind !== "page.summary") {
    throw new TypeError("orders.list expected page.summary");
  }
  return page;
}

export function listDocumentOrdersInfiniteOptions(args: {
  readonly client: DocumentOrdersListClient | null;
  readonly companyId: string | null;
  readonly input: ListDocumentOrdersPageInput;
  readonly getActiveCompany: () => string | null;
  readonly enabled?: boolean;
}) {
  const client = args.client;
  return {
    ...contractInfiniteQueryOptions({
      actionName: LIST_ORDERS_ACTION,
      companyId: args.companyId,
      input: args.input,
      getActiveCompany: args.getActiveCompany,
      queryFn: (cursor: string | null) => {
        if (client === null) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return fetchDocumentOrdersPage(client, args.input, cursor);
      },
      nextCursor: (page: ListOrdersSummaryPage) => page.nextCursor,
    }),
    enabled:
      (args.enabled ?? true) && client !== null && args.companyId !== null,
  };
}
