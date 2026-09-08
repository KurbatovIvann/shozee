/**
 * Client-safe staff search shapes and normalize helpers (SHO-527 / SHO-526).
 * Not AI-only Zod. Matcher tickets T3–T7 import this subpath.
 */
export {
  GLOBAL_HIT_CAP,
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_APOSTROPHE_CANON,
  SEARCH_APOSTROPHES,
  SEARCH_CATALOG_TYPES,
  SEARCH_CUSTOMER_TYPES,
  SEARCH_DOCUMENT_TYPE_CODES,
  SEARCH_ENTITY_TYPES,
  SEARCH_LABEL_MAX,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_LIMIT_PER_TYPE_MAX,
  SEARCH_LIMIT_PER_TYPE_MIN,
  SEARCH_MATCHED_ON,
  SEARCH_MATCHED_ON_PRIORITY,
  SEARCH_PHONE_MIN_DIGITS,
  SEARCH_QUERY_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  SEARCH_TOKEN_MAX,
  type SearchCatalogType,
  type SearchCustomerType,
  type SearchDocumentTypeCode,
  type SearchEntityType,
  type SearchMatchedOn,
} from "./constants.js";
export { dedupSearchHits, pickPreferredSearchHit } from "./dedup.js";
export type { SearchHitPreference, TypedSearchHit } from "./dedup.js";
export {
  SEARCH_GOLDEN_NAME_CASES,
  SEARCH_GOLDEN_ORDER_NUMBER_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
} from "./golden.js";
export type {
  SearchGoldenNameCase,
  SearchGoldenNameRow,
  SearchGoldenOrderNumberCase,
} from "./golden.js";
export {
  canonicalizeDocumentNumberQuery,
  canonicalizeEdrpou,
  canonicalizeEmail,
  canonicalizeOrderNumberToken,
  canonicalizePhoneDigits,
  collapseSearchWhitespace,
  foldSearchApostrophes,
  foldSearchNameToken,
  hasLetterOrDigit,
  prepareSearchQuery,
} from "./normalize.js";
export type {
  CanonicalDocumentNumberQuery,
  PreparedSearchQuery,
} from "./normalize.js";
export { sanitizeLikeLiteral } from "../pagination.js";
export {
  catalogSearchGroupSchema,
  catalogSearchMatchesInputSchema,
  catalogSearchMatchesOutputSchema,
  customersSearchGroupSchema,
  customersSearchMatchesInputSchema,
  customersSearchMatchesOutputSchema,
  documentsSearchMatchesInputSchema,
  documentsSearchMatchesOutputSchema,
  orderCustomerLookupSchema,
  ordersSearchMatchesInputSchema,
  ordersSearchMatchesOutputSchema,
  pricingSearchMatchesInputSchema,
  pricingSearchMatchesOutputSchema,
  SEARCH_QUERY_NORMALIZED_CLIP_MAX,
  searchCatalogTypeSchema,
  searchCustomerGroupSchema,
  searchCustomerGroupTypeSchema,
  searchCustomerTypeSchema,
  searchCounterpartyGroupSchema,
  searchDocumentGroupSchema,
  searchEntityTypeSchema,
  searchGroupSchema,
  searchHitSchema,
  searchLimitPerTypeSchema,
  searchMatchedOnSchema,
  searchMatcherBaseInputSchema,
  searchOrderGroupSchema,
  searchPriceListGroupSchema,
  searchProductGroupSchema,
  searchQueryInputSchema,
  searchQueryOutputSchema,
  searchQueryTextSchema,
  searchVariantGroupSchema,
  searchVariantHitSchema,
} from "./schemas.js";
export type {
  OrderCustomerLookup,
  SearchGroup,
  SearchHit,
  SearchQueryInput,
  SearchQueryOutput,
  SearchVariantHit,
} from "./schemas.js";
