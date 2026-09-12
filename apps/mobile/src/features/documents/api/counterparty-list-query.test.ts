import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import { contractQueryKey } from "../../../api/query-options";
import { DOCUMENT_LOOKUP_PAGE_SIZE } from "../shared/document-caps";
import {
  DOCUMENT_COUNTERPARTIES_COMPANY_INPUT,
  documentCounterpartiesLookupInput,
  LIST_COUNTERPARTIES_ACTION,
  listDocumentCounterpartiesInfiniteOptions,
  type DocumentCounterpartiesListClient,
} from "./counterparty-list-query";

function stubCounterpartiesListClient(
  onList: DocumentCounterpartiesListClient["client"]["customers"]["listCounterparties"],
): DocumentCounterpartiesListClient {
  return { client: { customers: { listCounterparties: onList } } };
}

const CUSTOMER_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

describe("listDocumentCounterpartiesInfiniteOptions", () => {
  it("keys [actionName, companyId, input] for company-wide and customer-scoped lists", () => {
    const scoped = listDocumentCounterpartiesInfiniteOptions({
      client: null,
      companyId: "company-a",
      customerId: CUSTOMER_ID,
      getActiveCompany: () => "company-a",
    });
    const otherCompany = listDocumentCounterpartiesInfiniteOptions({
      client: null,
      companyId: "company-b",
      customerId: CUSTOMER_ID,
      getActiveCompany: () => "company-b",
    });
    const companyWide = listDocumentCounterpartiesInfiniteOptions({
      client: null,
      companyId: "company-a",
      customerId: null,
      getActiveCompany: () => "company-a",
    });
    expect(scoped.queryKey).toEqual(
      contractQueryKey(
        LIST_COUNTERPARTIES_ACTION,
        "company-a",
        documentCounterpartiesLookupInput(CUSTOMER_ID),
      ),
    );
    expect(companyWide.queryKey).toEqual(
      contractQueryKey(
        LIST_COUNTERPARTIES_ACTION,
        "company-a",
        DOCUMENT_COUNTERPARTIES_COMPANY_INPUT,
      ),
    );
    expect(DOCUMENT_COUNTERPARTIES_COMPANY_INPUT.limit).toBe(
      DOCUMENT_LOOKUP_PAGE_SIZE,
    );
    expect(scoped.queryKey[1]).toBe("company-a");
    expect(scoped.queryKey).not.toEqual(otherCompany.queryKey);
    expect(scoped.queryKey).not.toEqual(companyWide.queryKey);
    expect(JSON.stringify(scoped.queryKey)).toContain(CUSTOMER_ID);
    expect(JSON.stringify(companyWide.queryKey)).not.toContain("customerId");
    expect(JSON.stringify(scoped.queryKey)).not.toContain("companyId");
    expect(scoped.enabled).toBe(false);
    expect(companyWide.enabled).toBe(false);
  });

  it("sends the customerId to customers.listCounterparties and fetches exactly one page at mount", async () => {
    const calls: unknown[] = [];
    const client = stubCounterpartiesListClient((input) => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: "cursor-1" });
    });
    const options = listDocumentCounterpartiesInfiniteOptions({
      client,
      companyId: "company-a",
      customerId: CUSTOMER_ID,
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(documentCounterpartiesLookupInput(CUSTOMER_ID));
    queryClient.clear();
  });
});
