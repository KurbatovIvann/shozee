import type { SearchEntityType } from "./constants.js";

export type SearchGoldenNameRow = {
  readonly type: SearchEntityType;
  readonly name: string;
  readonly productName?: string;
};

export type SearchGoldenNameCase = {
  readonly id: string;
  readonly query: string;
  readonly positives: readonly SearchGoldenNameRow[];
  readonly negatives: readonly SearchGoldenNameRow[];
};

/** Parent golden: «ванільний» must not hit on token-AND «макаронс шоколодний». */
export const SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME = "Макаронс ванільний";

/**
 * Golden set T3–T7 import (SHO-526). Encoded as fixtures, not matcher SQL.
 * Positives **and** the «ванільний» negative live here.
 */
export const SEARCH_GOLDEN_NAME_CASES = [
  {
    id: "word-prefix-mak",
    query: "мак",
    positives: [{ type: "product", name: "Макаронс" }],
    negatives: [],
  },
  {
    id: "token-and-excludes-vanilla",
    query: "макаронс шоколодний",
    positives: [{ type: "product", name: "Макаронс шоколадний" }],
    negatives: [{ type: "product", name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME }],
  },
  {
    id: "variant-combo-product-plus-variant",
    query: "макаронс шокол",
    positives: [
      {
        type: "variant",
        name: "Шоколадний",
        productName: "Макаронс",
      },
    ],
    negatives: [],
  },
  {
    id: "inflection-not-promised",
    query: "Олени",
    positives: [],
    negatives: [{ type: "customer", name: "Олена" }],
  },
] as const satisfies readonly SearchGoldenNameCase[];

export type SearchGoldenOrderNumberCase = {
  readonly id: string;
  readonly query: string;
  readonly companyPrefix: string;
  readonly expected: string | undefined;
};

export const SEARCH_GOLDEN_ORDER_NUMBER_CASES = [
  {
    id: "full-canonical",
    query: "SP-32KUY41",
    companyPrefix: "SP",
    expected: "SP-32KUY41",
  },
  {
    id: "hash-and-case",
    query: "#sp-32kuy41",
    companyPrefix: "SP",
    expected: "SP-32KUY41",
  },
  {
    id: "token-without-prefix",
    query: "32KUY41",
    companyPrefix: "SP",
    expected: "SP-32KUY41",
  },
  {
    id: "number-prefix",
    query: "32KU",
    companyPrefix: "SP",
    expected: "SP-32KU",
  },
  {
    id: "company-prefix-alone",
    query: "SP",
    companyPrefix: "SP",
    expected: undefined,
  },
] as const satisfies readonly SearchGoldenOrderNumberCase[];
