import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import {
  SEARCH_GOLDEN_NAME_CASES,
  SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
  SEARCH_NAME_TRGM_THRESHOLD,
  SEARCH_QUERY_MAX,
  SEARCH_SUBLABEL_MAX,
  type SearchHit,
  type SearchVariantHit,
} from "@showzy/validation/search";
import { or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchMatches } from "./search-matches.js";

const fixtures = {
  productMak: randomUUID(),
  productChoco: randomUUID(),
  productVanilla: randomUUID(),
  productArchived: randomUUID(),
  productForeignMak: randomUUID(),
  productForeignChoco: randomUUID(),
  variantChoco: randomUUID(),
  variantVanilla: randomUUID(),
  variantArchived: randomUUID(),
  variantForeign: randomUUID(),
  longParent: randomUUID(),
  variantLong: randomUUID(),
};

const clerkUserId = randomUUID();

const tokenAndCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "token-and-excludes-vanilla",
);
const wordPrefixCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "word-prefix-mak",
);
const variantComboCase = SEARCH_GOLDEN_NAME_CASES.find(
  (entry) => entry.id === "variant-combo-product-plus-variant",
);

const longParentName = `SublabelHost ${"м".repeat(80)}`;

let kit: TestKit;

beforeAll(async () => {
  expect(tokenAndCase?.query).toBe("макаронс шоколодний");
  expect(wordPrefixCase?.query).toBe("мак");
  expect(variantComboCase?.query).toBe("макаронс шокол");
  expect(SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME).toBe("Макаронс ванільний");
  expect(longParentName.length).toBeGreaterThan(SEARCH_SUBLABEL_MAX);

  kit = await createTestKit();

  await kit.db.runtime.db.insert(products).values([
    {
      id: fixtures.productMak,
      companyId: kitIdentities.companies.a,
      name: "Макаронс",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productChoco,
      companyId: kitIdentities.companies.a,
      name: "Макаронс шоколадний",
      basePriceMinor: 200n,
    },
    {
      id: fixtures.productVanilla,
      companyId: kitIdentities.companies.a,
      name: SEARCH_GOLDEN_VANILLA_NEGATIVE_NAME,
      basePriceMinor: 300n,
    },
    {
      id: fixtures.productArchived,
      companyId: kitIdentities.companies.a,
      name: "Archived Macaron",
      basePriceMinor: 50n,
      status: "archived",
    },
    {
      id: fixtures.productForeignMak,
      companyId: kitIdentities.companies.b,
      name: "Макаронс",
      basePriceMinor: 100n,
    },
    {
      id: fixtures.productForeignChoco,
      companyId: kitIdentities.companies.b,
      name: "Макаронс шоколадний",
      basePriceMinor: 200n,
    },
    {
      id: fixtures.longParent,
      companyId: kitIdentities.companies.a,
      name: longParentName,
      basePriceMinor: 10n,
    },
  ]);

  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variantChoco,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productMak,
      name: "Шоколадний",
    },
    {
      id: fixtures.variantVanilla,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productMak,
      name: "Ванільний",
    },
    {
      id: fixtures.variantArchived,
      companyId: kitIdentities.companies.a,
      productId: fixtures.productMak,
      name: "Archived Flavor",
      status: "archived",
    },
    {
      id: fixtures.variantForeign,
      companyId: kitIdentities.companies.b,
      productId: fixtures.productForeignMak,
      name: "Шоколадний",
    },
    {
      id: fixtures.variantLong,
      companyId: kitIdentities.companies.a,
      productId: fixtures.longParent,
      name: "Long Child",
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-search-matches.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: kitIdentities.companies.a,
    userId: clerkUserId,
    role: "employee",
    permissions: { granted: [], denied: ["products:view"] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

// Staff matcher has no resource id: the inherited suite's foreign case is
// Anna selecting company B (membership deny). The handler's company_id
// filter is proven by "keeps another company's products and variants out".
crossTenantSuite(
  () => kit,
  [
    isolationCase(
      searchMatches,
      { input: { query: "мак" } },
      {
        input: { query: "мак" },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("catalog.searchMatches", () => {
  it("returns empty groups without error for empty or punctuation-only queries", async () => {
    const empty = { groups: [] };
    expect(await kit.invoke(searchMatches, { query: "" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "   " })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "..." })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "!!! ???" })).toEqual(
      empty,
    );
    expect(await kit.invoke(searchMatches, { query: "%%%" })).toEqual(empty);
  });

  it("applies T2 name golden: word-prefix мак, token-AND vanilla negative, variant combo", async () => {
    expect(wordPrefixCase).toBeDefined();
    expect(tokenAndCase).toBeDefined();
    expect(variantComboCase).toBeDefined();
    if (
      wordPrefixCase === undefined ||
      tokenAndCase === undefined ||
      variantComboCase === undefined
    ) {
      return;
    }

    const prefix = await kit.invoke(searchMatches, {
      query: wordPrefixCase.query,
    });
    expect(hitIds(productGroup(prefix))).toEqual(
      expect.arrayContaining([
        fixtures.productMak,
        fixtures.productChoco,
        fixtures.productVanilla,
      ]),
    );
    expect(hitIds(productGroup(prefix))).not.toContain(
      fixtures.productForeignChoco,
    );
    // Combo includes the parent name, so `мак` hits the chocolate variant
    // even though the variant's own name is «Шоколадний».
    expect(hitIds(variantGroup(prefix))).toContain(fixtures.variantChoco);
    expect(hitIds(variantGroup(prefix))).toContain(fixtures.variantVanilla);

    const tokenAnd = await kit.invoke(searchMatches, {
      query: tokenAndCase.query,
    });
    expect(hitIds(productGroup(tokenAnd))).toContain(fixtures.productChoco);
    expect(hitIds(productGroup(tokenAnd))).not.toContain(
      fixtures.productVanilla,
    );
    expect(hitIds(variantGroup(tokenAnd))).toContain(fixtures.variantChoco);
    expect(hitIds(variantGroup(tokenAnd))).not.toContain(
      fixtures.variantVanilla,
    );
    const chocoProduct = productGroup(tokenAnd)?.hits.find(
      (hit) => hit.id === fixtures.productChoco,
    );
    expect(chocoProduct?.matchedOn).toBe("name");
    expect(chocoProduct?.exact).toBe(false);
    expect(chocoProduct).not.toHaveProperty("productId");

    const combo = await kit.invoke(searchMatches, {
      query: variantComboCase.query,
    });
    const chocoVariant = variantGroup(combo)?.hits.find(
      (hit) => hit.id === fixtures.variantChoco,
    );
    expect(chocoVariant).toEqual(
      expect.objectContaining({
        id: fixtures.variantChoco,
        label: "Шоколадний",
        sublabel: "Макаронс",
        productId: fixtures.productMak,
        matchedOn: "name",
        exact: false,
      }),
    );
    expect(hitIds(variantGroup(combo))).not.toContain(fixtures.variantVanilla);
    expect(hitIds(variantGroup(combo))).not.toContain(fixtures.variantForeign);
    expect(hitIds(productGroup(combo))).toContain(fixtures.productChoco);
    expect(hitIds(productGroup(combo))).not.toContain(fixtures.productVanilla);
  });

  it("sets variant productId from the parent column and truncates sublabel to 80", async () => {
    const listed = await kit.invoke(searchMatches, { query: "long child" });
    const hit = variantGroup(listed)?.hits.find(
      (row) => row.id === fixtures.variantLong,
    );
    expect(hit?.productId).toBe(fixtures.longParent);
    expect(hit?.sublabel).toBe(longParentName.slice(0, SEARCH_SUBLABEL_MAX));
    expect(hit?.sublabel?.length).toBe(SEARCH_SUBLABEL_MAX);
    expect(hit?.label).toBe("Long Child");
    expect(hit?.exact).toBe(true);
  });

  it("returns archived products and variants with status and does not hide them", async () => {
    const productListed = await kit.invoke(searchMatches, {
      query: "Archived Macaron",
    });
    const productHit = productGroup(productListed)?.hits.find(
      (row) => row.id === fixtures.productArchived,
    );
    expect(productHit?.status).toBe("archived");
    expect(productHit?.exact).toBe(true);
    expect(productHit?.matchedOn).toBe("name");

    const variantListed = await kit.invoke(searchMatches, {
      query: "Archived Flavor",
    });
    const variantHit = variantGroup(variantListed)?.hits.find(
      (row) => row.id === fixtures.variantArchived,
    );
    expect(variantHit?.status).toBe("archived");
    expect(variantHit?.productId).toBe(fixtures.productMak);
    expect(variantHit?.exact).toBe(true);
  });

  it("keeps another company's products and variants out of this tenant", async () => {
    const choco = await kit.invoke(searchMatches, {
      query: "макаронс шоколодний",
    });
    expect(hitIds(productGroup(choco))).toContain(fixtures.productChoco);
    expect(hitIds(productGroup(choco))).not.toContain(
      fixtures.productForeignChoco,
    );
    expect(hitIds(variantGroup(choco))).toContain(fixtures.variantChoco);
    expect(hitIds(variantGroup(choco))).not.toContain(fixtures.variantForeign);

    const other = await kit.invoke(
      searchMatches,
      { query: "макаронс шоколодний" },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(productGroup(other))).toEqual([fixtures.productForeignChoco]);
    expect(hitIds(variantGroup(other))).toEqual([fixtures.variantForeign]);
    expect(hitIds(productGroup(other))).not.toContain(fixtures.productChoco);
  });

  it("truncates the product group at limitPerType without inventing a second cap", async () => {
    const ids = await insertNamedProducts("DisplaySix", 6);
    const listed = await kit.invoke(searchMatches, {
      query: "DisplaySix",
      limitPerType: 5,
    });
    expect(productGroup(listed)?.truncated).toBe(true);
    expect(hitIds(productGroup(listed))).toHaveLength(5);
    expect(ids).toEqual(expect.arrayContaining(hitIds(productGroup(listed))));
  });

  it("omits a type group when types filter excludes it", async () => {
    const productsOnly = await kit.invoke(searchMatches, {
      query: "мак",
      types: ["product"],
    });
    expect(productsOnly.groups.map((group) => group.type)).toEqual(["product"]);
    expect(hitIds(productGroup(productsOnly))).toContain(fixtures.productMak);

    const variantsOnly = await kit.invoke(searchMatches, {
      query: "макаронс шокол",
      types: ["variant"],
    });
    expect(variantsOnly.groups.map((group) => group.type)).toEqual(["variant"]);
    expect(hitIds(variantGroup(variantsOnly))).toContain(fixtures.variantChoco);
  });

  it("denies staff without products:view", async () => {
    await expect(
      kit.invoke(
        searchMatches,
        { query: "мак" },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects oversize query, unknown type, and companyId in input", async () => {
    await expect(
      kit.invoke(searchMatches, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "мак",
        types: ["order"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "мак",
        companyId: kitIdentities.companies.b,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("runs with the clusterwide word-similarity threshold the matcher assumes", async () => {
    // `<%` carries no literal threshold — it reads this GUC, which
    // migration 0056 sets clusterwide. If the two drift, every trigram
    // branch silently changes selectivity with no error, so pin them.
    const shown = await kit.db.runtime.pool.query<{
      "pg_trgm.word_similarity_threshold": string;
    }>("SHOW pg_trgm.word_similarity_threshold");
    const threshold = shown.rows[0]?.["pg_trgm.word_similarity_threshold"];
    expect(threshold).toBeDefined();
    expect(Number(threshold)).toBe(SEARCH_NAME_TRGM_THRESHOLD);
  });

  it("matches names through index-servable operators, not a scan", async () => {
    // The pre-fix predicate was `word_similarity(token, name) >= 0.25` — a
    // function call in a filter, which `gin_trgm_ops` cannot serve at any
    // table size, and OR-ing it with the FTS branch blocked a BitmapOr so
    // `name_fts` went unused too. What this pins is that both branches can
    // now be *answered* from an index.
    //
    // The tenant conjunct is deliberately left out. On a fixture this small
    // the planner satisfies `company_id = X` from its own index and drops
    // the name predicate into a Filter — which it is free to do, and which
    // would hide the difference this test exists to catch.
    const token = "мак";
    const compiled = kit.db.runtime.db
      .select({ id: products.id })
      .from(products)
      .where(
        or(
          sql`${products.nameFts} @@ to_tsquery('simple', ${`${token}:*`})`,
          sql`${token} <% ${products.name}`,
        ),
      )
      .toSQL();

    await kit.db.admin.query("BEGIN");
    try {
      await kit.db.admin.query("SET LOCAL enable_seqscan = off");
      const explained = await kit.db.admin.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${compiled.sql}`,
        compiled.params,
      );
      const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan).toMatch(/BitmapOr/);
      expect(plan).toMatch(/products_name_fts_gin_idx/);
      expect(plan).toMatch(/products_name_trgm_idx/);
      expect(plan).not.toMatch(/\bSeq Scan\b/);
    } finally {
      await kit.db.admin.query("ROLLBACK");
    }
  });
});

async function insertNamedProducts(
  prefix: string,
  count: number,
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await kit.db.runtime.db.insert(products).values(
    ids.map((id, index) => ({
      id,
      companyId: kitIdentities.companies.a,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
      basePriceMinor: 100n,
    })),
  );
  return ids;
}

type SearchMatchesResult = {
  groups: ReadonlyArray<
    | {
        type: "product";
        hits: readonly SearchHit[];
        truncated: boolean;
      }
    | {
        type: "variant";
        hits: readonly SearchVariantHit[];
        truncated: boolean;
      }
  >;
};

type ProductGroup = Extract<
  SearchMatchesResult["groups"][number],
  { type: "product" }
>;
type VariantGroup = Extract<
  SearchMatchesResult["groups"][number],
  { type: "variant" }
>;

function productGroup(result: SearchMatchesResult): ProductGroup | undefined {
  return result.groups.find(
    (group): group is ProductGroup => group.type === "product",
  );
}

function variantGroup(result: SearchMatchesResult): VariantGroup | undefined {
  return result.groups.find(
    (group): group is VariantGroup => group.type === "variant",
  );
}

function hitIds(
  group: { hits: ReadonlyArray<{ id: string }> } | undefined,
): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}
