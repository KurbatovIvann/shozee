import { z } from "zod";

import { listLimitInput } from "../pagination.js";

import {
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_CATALOG_TYPES,
  SEARCH_CUSTOMER_TYPES,
  SEARCH_ENTITY_TYPES,
  SEARCH_LABEL_MAX,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_LIMIT_PER_TYPE_MAX,
  SEARCH_MATCHED_ON,
  SEARCH_QUERY_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
} from "./constants.js";

export const searchEntityTypeSchema = z.enum(SEARCH_ENTITY_TYPES);
export const searchCustomerTypeSchema = z.enum(SEARCH_CUSTOMER_TYPES);
export const searchCatalogTypeSchema = z.enum(SEARCH_CATALOG_TYPES);
export const searchMatchedOnSchema = z.enum(SEARCH_MATCHED_ON);

export const searchLimitPerTypeSchema = listLimitInput(
  SEARCH_LIMIT_PER_TYPE_MAX,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
);

export const searchQueryTextSchema = z.string().max(SEARCH_QUERY_MAX);

const searchHitFields = {
  id: z.uuid(),
  label: z.string().min(1).max(SEARCH_LABEL_MAX),
  sublabel: z.string().min(1).max(SEARCH_SUBLABEL_MAX).optional(),
  status: z.string().min(1).max(SEARCH_STATUS_MAX).optional(),
  matchedOn: searchMatchedOnSchema,
  exact: z.boolean(),
};

/** Hit without `productId` — every group type except `variant`. */
export const searchHitSchema = z.strictObject(searchHitFields);

/** Variant hits require a typed parent product id (not recovered from sublabel). */
export const searchVariantHitSchema = z.strictObject({
  ...searchHitFields,
  productId: z.uuid(),
});

function searchGroupObject<Type extends z.ZodType, Hit extends z.ZodType>(
  type: Type,
  hit: Hit,
) {
  return z.strictObject({
    type,
    hits: z.array(hit),
    truncated: z.boolean(),
  });
}

export const searchOrderGroupSchema = searchGroupObject(
  z.literal("order"),
  searchHitSchema,
);
export const searchCustomerGroupSchema = searchGroupObject(
  z.literal("customer"),
  searchHitSchema,
);
export const searchCustomerGroupTypeSchema = searchGroupObject(
  z.literal("customerGroup"),
  searchHitSchema,
);
export const searchCounterpartyGroupSchema = searchGroupObject(
  z.literal("counterparty"),
  searchHitSchema,
);
export const searchProductGroupSchema = searchGroupObject(
  z.literal("product"),
  searchHitSchema,
);
export const searchVariantGroupSchema = searchGroupObject(
  z.literal("variant"),
  searchVariantHitSchema,
);
export const searchPriceListGroupSchema = searchGroupObject(
  z.literal("priceList"),
  searchHitSchema,
);
export const searchDocumentGroupSchema = searchGroupObject(
  z.literal("document"),
  searchHitSchema,
);

export const searchGroupSchema = z.discriminatedUnion("type", [
  searchOrderGroupSchema,
  searchCustomerGroupSchema,
  searchCustomerGroupTypeSchema,
  searchCounterpartyGroupSchema,
  searchProductGroupSchema,
  searchVariantGroupSchema,
  searchPriceListGroupSchema,
  searchDocumentGroupSchema,
]);

export const customersSearchGroupSchema = z.discriminatedUnion("type", [
  searchCustomerGroupSchema,
  searchCustomerGroupTypeSchema,
  searchCounterpartyGroupSchema,
]);

export const catalogSearchGroupSchema = z.discriminatedUnion("type", [
  searchProductGroupSchema,
  searchVariantGroupSchema,
]);

export const searchQueryInputSchema = z.strictObject({
  query: searchQueryTextSchema,
  types: z
    .array(searchEntityTypeSchema)
    .max(SEARCH_ENTITY_TYPES.length)
    .optional(),
  limitPerType: searchLimitPerTypeSchema,
});

export const searchQueryOutputSchema = z.strictObject({
  groups: z.array(searchGroupSchema),
  searchedTypes: z.array(searchEntityTypeSchema),
  queryNormalized: z.string().max(SEARCH_QUERY_MAX),
});

export const searchMatcherBaseInputSchema = z.strictObject({
  query: searchQueryTextSchema,
  limitPerType: searchLimitPerTypeSchema,
});

export const customersSearchMatchesInputSchema = z.strictObject({
  query: searchQueryTextSchema,
  types: z
    .array(searchCustomerTypeSchema)
    .max(SEARCH_CUSTOMER_TYPES.length)
    .optional(),
  limitPerType: searchLimitPerTypeSchema,
});

export const orderCustomerLookupSchema = z.strictObject({
  ids: z.array(z.uuid()).max(ORDER_CUSTOMER_LOOKUP_MAX),
  truncated: z.boolean(),
});

export const customersSearchMatchesOutputSchema = z.strictObject({
  groups: z.array(customersSearchGroupSchema),
  orderCustomerLookup: orderCustomerLookupSchema,
});

export const catalogSearchMatchesInputSchema = z.strictObject({
  query: searchQueryTextSchema,
  types: z
    .array(searchCatalogTypeSchema)
    .max(SEARCH_CATALOG_TYPES.length)
    .optional(),
  limitPerType: searchLimitPerTypeSchema,
});

export const catalogSearchMatchesOutputSchema = z.strictObject({
  groups: z.array(catalogSearchGroupSchema),
});

export const ordersSearchMatchesInputSchema = z.strictObject({
  query: searchQueryTextSchema,
  limitPerType: searchLimitPerTypeSchema,
  customerIds: z.array(z.uuid()).max(ORDER_CUSTOMER_LOOKUP_MAX).optional(),
});

export const ordersSearchMatchesOutputSchema = z.strictObject({
  groups: z.array(searchOrderGroupSchema),
});

export const pricingSearchMatchesInputSchema = searchMatcherBaseInputSchema;

export const pricingSearchMatchesOutputSchema = z.strictObject({
  groups: z.array(searchPriceListGroupSchema),
});

export const documentsSearchMatchesInputSchema = searchMatcherBaseInputSchema;

export const documentsSearchMatchesOutputSchema = z.strictObject({
  groups: z.array(searchDocumentGroupSchema),
});

export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchVariantHit = z.infer<typeof searchVariantHitSchema>;
export type SearchGroup = z.infer<typeof searchGroupSchema>;
export type SearchQueryInput = z.infer<typeof searchQueryInputSchema>;
export type SearchQueryOutput = z.infer<typeof searchQueryOutputSchema>;
export type OrderCustomerLookup = z.infer<typeof orderCustomerLookupSchema>;

/** Clip-budget reminder for T9: `queryNormalized` is at most this length. */
export const SEARCH_QUERY_NORMALIZED_CLIP_MAX = SEARCH_QUERY_MAX;
