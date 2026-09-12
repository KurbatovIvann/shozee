import type { ContractClient } from "../../../api/client";
import { contractInfiniteQueryOptions } from "../../../api/query-options";
import { DOCUMENT_LOOKUP_PAGE_SIZE } from "../shared/document-caps";

export const LIST_COUNTERPARTIES_ACTION = "customers.listCounterparties";

type ShowzyClient = ContractClient;
export type ListCounterpartiesOutput = Awaited<
  ReturnType<ShowzyClient["client"]["customers"]["listCounterparties"]>
>;
export type DocumentCounterpartyListItem =
  ListCounterpartiesOutput["items"][number];

export type DocumentCounterpartiesListClient = {
  readonly client: {
    readonly customers: {
      readonly listCounterparties: ShowzyClient["client"]["customers"]["listCounterparties"];
    };
  };
};

export function documentCounterpartiesLookupInput(customerId: string): {
  readonly customerId: string;
  readonly limit: number;
} {
  return {
    customerId,
    limit: DOCUMENT_LOOKUP_PAGE_SIZE,
  };
}

export function listDocumentCounterpartiesInfiniteOptions(args: {
  readonly client: DocumentCounterpartiesListClient | null;
  readonly companyId: string | null;
  readonly customerId: string | null;
  readonly getActiveCompany: () => string | null;
  readonly enabled?: boolean;
}) {
  const client = args.client;
  const customerId = args.customerId;
  const input = documentCounterpartiesLookupInput(customerId ?? "");
  return {
    ...contractInfiniteQueryOptions({
      actionName: LIST_COUNTERPARTIES_ACTION,
      companyId: args.companyId,
      input,
      getActiveCompany: args.getActiveCompany,
      queryFn: (cursor: string | null) => {
        if (client === null || customerId === null) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return client.client.customers.listCounterparties({
          ...documentCounterpartiesLookupInput(customerId),
          ...(cursor === null ? {} : { cursor }),
        });
      },
      nextCursor: (page: ListCounterpartiesOutput) => page.nextCursor,
    }),
    enabled:
      (args.enabled ?? true) &&
      client !== null &&
      args.companyId !== null &&
      customerId !== null,
  };
}
