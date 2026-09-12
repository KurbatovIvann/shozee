import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import { contractQueryKey } from "../../../api/query-options";
import { DOCUMENT_LOOKUP_PAGE_SIZE } from "../shared/document-caps";
import {
  DOCUMENT_ORDERS_LOOKUP_INPUT,
  LIST_ORDERS_ACTION,
  documentOrdersLookupInput,
  listDocumentOrdersInfiniteOptions,
  type DocumentOrdersListClient,
} from "./order-list-query";

function stubOrdersListClient(
  onList: DocumentOrdersListClient["client"]["orders"]["list"],
): DocumentOrdersListClient {
  return { client: { orders: { list: onList } } };
}

describe("documentOrdersLookupInput", () => {
  it("omits filter.query when undefined and includes it otherwise", () => {
    expect(documentOrdersLookupInput(undefined)).toEqual(
      DOCUMENT_ORDERS_LOOKUP_INPUT,
    );
    expect(documentOrdersLookupInput("торт")).toEqual({
      ...DOCUMENT_ORDERS_LOOKUP_INPUT,
      filter: { ...DOCUMENT_ORDERS_LOOKUP_INPUT.filter, query: "торт" },
    });
  });
});

describe("listDocumentOrdersInfiniteOptions", () => {
  it("keys [actionName, companyId, input] for confirmed orders, includes the query in the key, and keeps cursor out of it", () => {
    const companyA = listDocumentOrdersInfiniteOptions({
      client: null,
      companyId: "company-a",
      input: documentOrdersLookupInput("KA-K7X2"),
      getActiveCompany: () => "company-a",
    });
    const companyB = listDocumentOrdersInfiniteOptions({
      client: null,
      companyId: "company-b",
      input: documentOrdersLookupInput("KA-K7X2"),
      getActiveCompany: () => "company-b",
    });
    expect(DOCUMENT_ORDERS_LOOKUP_INPUT).toEqual({
      kind: "page.summary",
      filter: { statuses: ["confirmed"] },
      limit: DOCUMENT_LOOKUP_PAGE_SIZE,
    });
    expect(DOCUMENT_ORDERS_LOOKUP_INPUT.filter.statuses).not.toContain(
      "canceled",
    );
    expect(companyA.queryKey).toEqual(
      contractQueryKey(
        LIST_ORDERS_ACTION,
        "company-a",
        documentOrdersLookupInput("KA-K7X2"),
      ),
    );
    expect(companyA.queryKey).not.toEqual(companyB.queryKey);
    expect(companyA.queryKey[1]).toBe("company-a");
    expect(JSON.stringify(companyA.queryKey)).not.toContain("cursor");
    expect(JSON.stringify(companyA.queryKey)).not.toContain("companyId");
    expect(companyA.enabled).toBe(false);
  });

  it("sends the typed search term to orders.list and fetches exactly one page at mount", async () => {
    const calls: unknown[] = [];
    const client = stubOrdersListClient((input) => {
      calls.push(input);
      return Promise.resolve({
        kind: "page.summary",
        items: [],
        nextCursor: "cursor-1",
        customerMatchTruncated: false,
      });
    });
    const options = listDocumentOrdersInfiniteOptions({
      client,
      companyId: "company-a",
      input: documentOrdersLookupInput("KA-K7X2"),
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(documentOrdersLookupInput("KA-K7X2"));
    queryClient.clear();
  });
});
