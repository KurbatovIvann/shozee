import { describe, expect, it } from "vitest";

import { sanitizeLikeLiteral } from "./pagination.js";
import {
  canonicalizeDocumentNumberQuery,
  canonicalizeEdrpou,
  canonicalizeEmail,
  canonicalizeOrderNumberToken,
  canonicalizePhoneDigits,
  dedupSearchHits,
  GLOBAL_HIT_CAP,
  ORDER_CUSTOMER_LOOKUP_MAX,
  pickPreferredSearchHit,
  prepareSearchQuery,
  SEARCH_GOLDEN_NAME_CASES,
  SEARCH_GOLDEN_ORDER_NUMBER_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  SEARCH_LABEL_MAX,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_LIMIT_PER_TYPE_MAX,
  SEARCH_LIMIT_PER_TYPE_MIN,
  SEARCH_PHONE_MIN_DIGITS,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_NORMALIZED_CLIP_MAX,
  SEARCH_SUBLABEL_MAX,
  SEARCH_TOKEN_MAX,
  catalogSearchMatchesOutputSchema,
  customersSearchMatchesOutputSchema,
  orderCustomerLookupSchema,
  searchHitSchema,
  searchQueryInputSchema,
  searchQueryOutputSchema,
  searchVariantGroupSchema,
  searchVariantHitSchema,
} from "./search/index.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

describe("@showzy/validation/search constants", () => {
  it("exports the named caps the feature card named", () => {
    expect(SEARCH_QUERY_MAX).toBe(100);
    expect(SEARCH_QUERY_NORMALIZED_CLIP_MAX).toBe(100);
    expect(SEARCH_TOKEN_MAX).toBe(8);
    expect(SEARCH_LIMIT_PER_TYPE_DEFAULT).toBe(5);
    expect(SEARCH_LIMIT_PER_TYPE_MIN).toBe(1);
    expect(SEARCH_LIMIT_PER_TYPE_MAX).toBe(10);
    expect(GLOBAL_HIT_CAP).toBe(40);
    expect(ORDER_CUSTOMER_LOOKUP_MAX).toBe(20);
    expect(SEARCH_LABEL_MAX).toBe(120);
    expect(SEARCH_SUBLABEL_MAX).toBe(80);
    expect(SEARCH_PHONE_MIN_DIGITS).toBe(5);
  });
});

describe("prepareSearchQuery", () => {
  it("treats empty and whitespace as empty-query, not VALIDATION", () => {
    expect(prepareSearchQuery("")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
    expect(prepareSearchQuery("   ")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
  });

  it("treats punctuation-only (no letters/digits) as empty-query", () => {
    expect(prepareSearchQuery("...")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
    expect(prepareSearchQuery("!!! ???")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
    expect(prepareSearchQuery("#")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
  });

  it("treats LIKE-sanitize-empty as empty-query", () => {
    expect(sanitizeLikeLiteral("%%%")).toBeUndefined();
    expect(prepareSearchQuery("%%%")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
    expect(prepareSearchQuery("___")).toEqual({
      empty: true,
      queryNormalized: "",
      tokens: [],
    });
  });

  it("NFC-trims, collapses whitespace, and case-folds name tokens", () => {
    const prepared = prepareSearchQuery("  Макаронс   Шоколад  ");
    expect(prepared.empty).toBe(false);
    if (prepared.empty) {
      return;
    }
    expect(prepared.queryNormalized).toBe("Макаронс Шоколад");
    expect(prepared.tokens).toEqual(["макаронс", "шоколад"]);
  });

  it("folds apostrophes ', ’, ʼ to one mark for names", () => {
    const ascii = prepareSearchQuery("О'лена");
    const curly = prepareSearchQuery("О\u2019лена");
    const modifier = prepareSearchQuery("О\u02BCлена");
    expect(ascii.empty).toBe(false);
    expect(curly.empty).toBe(false);
    expect(modifier.empty).toBe(false);
    if (ascii.empty || curly.empty || modifier.empty) {
      return;
    }
    expect(ascii.tokens).toEqual(curly.tokens);
    expect(ascii.tokens).toEqual(modifier.tokens);
    expect(ascii.tokens[0]).toBe("о'лена");
  });

  it("ignores extra tokens after SEARCH_TOKEN_MAX instead of VALIDATION", () => {
    const tokens = ["а", "б", "в", "г", "д", "е", "є", "ж", "з", "и"];
    const prepared = prepareSearchQuery(tokens.join(" "));
    expect(prepared.empty).toBe(false);
    if (prepared.empty) {
      return;
    }
    expect(prepared.tokens).toHaveLength(SEARCH_TOKEN_MAX);
    expect(prepared.tokens).toEqual(["а", "б", "в", "г", "д", "е", "є", "ж"]);
  });
});

describe("canonicalizePhoneDigits", () => {
  it("canonicalizes UA 0… and +380… to the same 380… digit string", () => {
    expect(canonicalizePhoneDigits("0671234567")).toBe("380671234567");
    expect(canonicalizePhoneDigits("+380671234567")).toBe("380671234567");
    expect(canonicalizePhoneDigits("380671234567")).toBe("380671234567");
  });

  it("prefix-canonicalizes short national and international prefixes the same way", () => {
    expect(canonicalizePhoneDigits("06712")).toBe("3806712");
    expect(canonicalizePhoneDigits("+3806712")).toBe("3806712");
  });

  it("rejects shorter than 5 digits after canonicalize", () => {
    expect(canonicalizePhoneDigits("06")).toBeUndefined();
    expect(canonicalizePhoneDigits("1234")).toBeUndefined();
    expect(canonicalizePhoneDigits("3801")).toBeUndefined();
  });
});

describe("canonicalizeEmail and canonicalizeEdrpou", () => {
  it("lower-trims email for equality", () => {
    expect(canonicalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
    expect(canonicalizeEmail("   ")).toBeUndefined();
  });

  it("keeps digits-only ЄДРПОУ for equality", () => {
    expect(canonicalizeEdrpou("12345678")).toBe("12345678");
    expect(canonicalizeEdrpou("1234 5678")).toBe("12345678");
    expect(canonicalizeEdrpou("abc")).toBeUndefined();
  });
});

describe("canonicalizeOrderNumberToken", () => {
  it("strips #, folds case, and prepends prefix when there is no hyphen", () => {
    expect(canonicalizeOrderNumberToken("SP-32KUY41", "SP")).toBe("SP-32KUY41");
    expect(canonicalizeOrderNumberToken("#sp-32kuy41", "SP")).toBe(
      "SP-32KUY41",
    );
    expect(canonicalizeOrderNumberToken("32KUY41", "SP")).toBe("SP-32KUY41");
  });

  it("does not treat the company prefix alone as a number token", () => {
    expect(canonicalizeOrderNumberToken("SP", "SP")).toBeUndefined();
    expect(canonicalizeOrderNumberToken("#sp", "SP")).toBeUndefined();
  });
});

describe("canonicalizeDocumentNumberQuery", () => {
  it("does not reuse the order algorithm for a bare sequence", () => {
    expect(canonicalizeDocumentNumberQuery("000001", "SP")).toEqual({
      kind: "seq",
      sequence: "000001",
    });
    expect(canonicalizeDocumentNumberQuery("1", "SP")).toEqual({
      kind: "seq",
      sequence: "000001",
    });
    expect(canonicalizeOrderNumberToken("000001", "SP")).toBe("SP-000001");
  });

  it("accepts full, hashed, and type-seq forms", () => {
    expect(canonicalizeDocumentNumberQuery("SP-РХ-000001", "SP")).toEqual({
      kind: "canonical",
      value: "SP-РХ-000001",
    });
    expect(canonicalizeDocumentNumberQuery("#sp-рх-000001", "SP")).toEqual({
      kind: "canonical",
      value: "SP-РХ-000001",
    });
    expect(canonicalizeDocumentNumberQuery("РХ-000001", "SP")).toEqual({
      kind: "canonical",
      value: "SP-РХ-000001",
    });
  });

  it("treats the company prefix alone as no document-number match", () => {
    expect(canonicalizeDocumentNumberQuery("SP", "SP")).toEqual({
      kind: "none",
    });
  });
});

describe("search query / hit schemas", () => {
  it("accepts empty query and defaults limitPerType to 5", () => {
    expect(searchQueryInputSchema.parse({ query: "" })).toEqual({
      query: "",
      limitPerType: 5,
    });
    expect(
      searchQueryInputSchema.parse({ query: "мак", limitPerType: 10 }),
    ).toEqual({ query: "мак", limitPerType: 10 });
    expect(
      searchQueryInputSchema.safeParse({
        query: "x".repeat(SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      searchQueryInputSchema.safeParse({ query: "мак", limitPerType: 0 })
        .success,
    ).toBe(false);
    expect(
      searchQueryInputSchema.safeParse({ query: "мак", cursor: "x" }).success,
    ).toBe(false);
  });

  it("requires productId on variant hits and omits it on other types", () => {
    const variantHit = {
      id: ID_A,
      label: "Шоколадний",
      matchedOn: "name" as const,
      exact: false,
      productId: PRODUCT_ID,
    };
    expect(searchVariantHitSchema.parse(variantHit)).toEqual(variantHit);
    expect(
      searchVariantHitSchema.safeParse({
        id: ID_A,
        label: "Шоколадний",
        matchedOn: "name",
        exact: false,
      }).success,
    ).toBe(false);
    expect(
      searchHitSchema.safeParse({
        id: ID_A,
        label: "Макаронс",
        matchedOn: "name",
        exact: true,
        productId: PRODUCT_ID,
      }).success,
    ).toBe(false);
    expect(
      searchVariantGroupSchema.parse({
        type: "variant",
        truncated: false,
        hits: [variantHit],
      }).type,
    ).toBe("variant");
  });

  it("includes orderCustomerLookup on customers matcher output", () => {
    const parsed = customersSearchMatchesOutputSchema.parse({
      groups: [],
      orderCustomerLookup: { ids: [ID_A], truncated: false },
    });
    expect(parsed.orderCustomerLookup).toEqual({
      ids: [ID_A],
      truncated: false,
    });
    expect(
      orderCustomerLookupSchema.safeParse({
        ids: Array.from({ length: 21 }, () => ID_A),
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("caps queryNormalized at SEARCH_QUERY_MAX for the T9 clip budget", () => {
    const output = searchQueryOutputSchema.parse({
      groups: [],
      searchedTypes: ["order"],
      queryNormalized: "м".repeat(SEARCH_QUERY_MAX),
    });
    expect(output.queryNormalized).toHaveLength(SEARCH_QUERY_MAX);
    expect(
      searchQueryOutputSchema.safeParse({
        groups: [],
        searchedTypes: ["order"],
        queryNormalized: "м".repeat(SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("requires productId inside catalog variant groups", () => {
    expect(
      catalogSearchMatchesOutputSchema.safeParse({
        groups: [
          {
            type: "variant",
            truncated: false,
            hits: [
              {
                id: ID_A,
                label: "Шоколадний",
                matchedOn: "name",
                exact: false,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("dedupSearchHits", () => {
  it("keeps one row per (type, id), exact over non-exact, then matchedOn priority", () => {
    const kept = dedupSearchHits([
      {
        type: "order",
        id: ID_A,
        exact: false,
        matchedOn: "customerNameSnapshot",
      },
      {
        type: "order",
        id: ID_A,
        exact: false,
        matchedOn: "number",
      },
      {
        type: "order",
        id: ID_A,
        exact: true,
        matchedOn: "customer",
      },
      {
        type: "customer",
        id: ID_A,
        exact: true,
        matchedOn: "name",
      },
      {
        type: "order",
        id: ID_B,
        exact: false,
        matchedOn: "number",
      },
    ]);
    expect(kept).toEqual([
      {
        type: "order",
        id: ID_A,
        exact: true,
        matchedOn: "customer",
      },
      {
        type: "customer",
        id: ID_A,
        exact: true,
        matchedOn: "name",
      },
      {
        type: "order",
        id: ID_B,
        exact: false,
        matchedOn: "number",
      },
    ]);
    expect(
      pickPreferredSearchHit(
        { exact: false, matchedOn: "phone" },
        { exact: false, matchedOn: "email" },
      ).matchedOn,
    ).toBe("phone");
    expect(ID_B).toHaveLength(36);
  });
});

describe("search golden fixtures", () => {
  it("compile positives and the ванільний negative", () => {
    const tokenAnd = SEARCH_GOLDEN_NAME_CASES.find(
      (entry) => entry.id === "token-and-excludes-vanilla",
    );
    expect(tokenAnd).toBeDefined();
    expect(tokenAnd?.query).toBe("макаронс шоколодний");
    expect(tokenAnd?.positives).toEqual([
      { type: "product", name: "Макаронс шоколадний" },
    ]);
    expect(tokenAnd?.negatives).toEqual([
      { type: "product", name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME },
    ]);
    expect(SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME).toBe("Макаронс ванільний");
    expect(SEARCH_GOLDEN_NAME_CASES).toHaveLength(4);
    expect(SEARCH_GOLDEN_ORDER_NUMBER_CASES.map((entry) => entry.id)).toContain(
      "company-prefix-alone",
    );
    for (const entry of SEARCH_GOLDEN_ORDER_NUMBER_CASES) {
      expect(
        canonicalizeOrderNumberToken(entry.query, entry.companyPrefix),
      ).toBe(entry.expected);
    }
  });
});
