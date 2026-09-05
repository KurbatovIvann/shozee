import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ReferenceResolutionConflictError,
  ambiguousProductQueryMessage,
  archivedProductMessage,
  archivedProductQueryMessage,
} from "../services/reference-resolution-conflict.js";
import {
  resolveCatalogLineReferences,
  type LineReferenceInput,
} from "../services/resolve-line-references.js";
import { resolveLineReferences } from "./resolve-line-references.js";
import {
  RESOLVE_LINE_REFERENCES_MAX_LINES,
  VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
  VARIANT_SELECTION_OPTIONS_MAX,
  type VariantSelection,
} from "./resolve-line-references.contract.js";

const fixtures = {
  alpha: randomUUID(),
  zero: randomUUID(),
  cafe: randomUUID(),
  coat: randomUUID(),
  twinUah: randomUUID(),
  twinEur: randomUUID(),
  archived: randomUUID(),
  archivedAlpha: randomUUID(),
  archivedCoat: randomUUID(),
  archivedTwin: randomUUID(),
  archivedTwinOne: randomUUID(),
  archivedTwinTwo: randomUUID(),
  archivedVariable: randomUUID(),
  foreign: randomUUID(),
  foreignArchived: randomUUID(),
  otherRedProduct: randomUUID(),
  retiredBox: randomUUID(),
  macarons: randomUUID(),
  variantRed: randomUUID(),
  variantBlue: randomUUID(),
  variantArchived: randomUUID(),
  variantOtherRed: randomUUID(),
  variantForeign: randomUUID(),
  variantRetired: randomUUID(),
  variantArchivedVariable: randomUUID(),
  macaronLemon: randomUUID(),
  macaronChocolate: randomUUID(),
  macaronVanilla: randomUUID(),
  macaronRaspberry: randomUUID(),
  macaronPistachio: randomUUID(),
  macaronSaltedCaramel: randomUUID(),
};

const clerkUserId = randomUUID();

let kit: TestKit;

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
  basePriceMinor: bigint;
  currency?: string;
  status?: "active" | "archived";
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: values.basePriceMinor,
    ...(values.currency === undefined ? {} : { currency: values.currency }),
    ...(values.status === undefined ? {} : { status: values.status }),
  });
}

function expectResolutionConflict(
  error: unknown,
): ReferenceResolutionConflictError {
  expect(error).toBeInstanceOf(ReferenceResolutionConflictError);
  expect(error).toBeInstanceOf(ConflictError);
  if (!(error instanceof ReferenceResolutionConflictError)) {
    throw new Error("expected ReferenceResolutionConflictError");
  }
  expect(error.code).toBe("CONFLICT");
  return error;
}

type PoolQueryClient = {
  query: (...args: never[]) => unknown;
};

type StatementPool = {
  on(
    event: "acquire",
    listener: (client: PoolQueryClient) => void,
  ): StatementPool;
};

const tappedPools = new WeakSet<object>();
const tappedClients = new WeakSet<object>();
let activeStatements: string[] | undefined;

function sqlTextFromQueryConfig(config: unknown): string | undefined {
  if (typeof config === "string") {
    return config;
  }
  if (typeof config !== "object" || config === null || !("text" in config)) {
    return undefined;
  }
  const text = config.text;
  return typeof text === "string" ? text : undefined;
}

function ensureStatementTap(pool: StatementPool): void {
  if (tappedPools.has(pool)) {
    return;
  }
  tappedPools.add(pool);
  pool.on("acquire", (client) => {
    if (tappedClients.has(client)) {
      return;
    }
    tappedClients.add(client);
    const originalQuery = client.query.bind(client);
    client.query = (...args: never[]) => {
      if (activeStatements !== undefined) {
        const text = sqlTextFromQueryConfig(args[0]);
        if (text !== undefined) {
          activeStatements.push(text);
        }
      }
      return originalQuery(...args);
    };
  });
}

function isCatalogReadSql(sql: string): boolean {
  const normalized = sql.toLowerCase();
  return (
    normalized.includes('from "products"') ||
    normalized.includes('from "product_variants"')
  );
}

async function collectStatements<T>(run: () => Promise<T>): Promise<{
  readonly outcome: PromiseSettledResult<T>;
  readonly statements: readonly string[];
}> {
  ensureStatementTap(kit.db.runtime.pool);
  const statements: string[] = [];
  activeStatements = statements;
  try {
    const value = await run();
    return { outcome: { status: "fulfilled", value }, statements };
  } catch (reason) {
    return { outcome: { status: "rejected", reason }, statements };
  } finally {
    activeStatements = undefined;
  }
}

function catalogReadStatementCount(statements: readonly string[]): number {
  return statements.filter((sql) => isCatalogReadSql(sql)).length;
}

function staffReadDb(): {
  select: (typeof kit.db.runtime.db)["select"];
  selectDistinct: (typeof kit.db.runtime.db)["selectDistinct"];
  selectDistinctOn: (typeof kit.db.runtime.db)["selectDistinctOn"];
  $count: (typeof kit.db.runtime.db)["$count"];
} {
  const db = kit.db.runtime.db;
  return {
    select: db.select.bind(db),
    selectDistinct: db.selectDistinct.bind(db),
    selectDistinctOn: db.selectDistinctOn.bind(db),
    $count: db.$count.bind(db),
  };
}

async function invokeResolveFailure(
  lines: readonly LineReferenceInput[],
): Promise<unknown> {
  return kit.invoke(resolveLineReferences, { lines }).then(
    () => {
      throw new Error("expected resolveLineReferences to fail");
    },
    (caught: unknown) => caught,
  );
}

beforeAll(async () => {
  kit = await createTestKit();

  await insertProduct({
    id: fixtures.alpha,
    companyId: kitIdentities.companies.a,
    name: "Alpha",
    basePriceMinor: 1500n,
  });
  await insertProduct({
    id: fixtures.zero,
    companyId: kitIdentities.companies.a,
    name: "Zero",
    basePriceMinor: 0n,
  });
  await insertProduct({
    id: fixtures.cafe,
    companyId: kitIdentities.companies.a,
    name: "Caf\u00e9 Cake",
    basePriceMinor: 100n,
  });
  await insertProduct({
    id: fixtures.coat,
    companyId: kitIdentities.companies.a,
    name: "Coat",
    basePriceMinor: 800n,
  });
  await insertProduct({
    id: fixtures.twinUah,
    companyId: kitIdentities.companies.a,
    name: "TwinCake",
    basePriceMinor: 100n,
  });
  await insertProduct({
    id: fixtures.twinEur,
    companyId: kitIdentities.companies.a,
    name: "TwinCake",
    basePriceMinor: 100n,
    currency: "EUR",
  });
  await insertProduct({
    id: fixtures.archived,
    companyId: kitIdentities.companies.a,
    name: "Old Widget",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedAlpha,
    companyId: kitIdentities.companies.a,
    name: "Alpha",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedCoat,
    companyId: kitIdentities.companies.a,
    name: "Coat",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedTwin,
    companyId: kitIdentities.companies.a,
    name: "TwinCake",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedTwinOne,
    companyId: kitIdentities.companies.a,
    name: "ZzzArchiveTwin One",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedTwinTwo,
    companyId: kitIdentities.companies.a,
    name: "ZzzArchiveTwin Two",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.archivedVariable,
    companyId: kitIdentities.companies.a,
    name: "Archived Variable Box",
    basePriceMinor: 20n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.foreign,
    companyId: kitIdentities.companies.b,
    name: "Alpha",
    basePriceMinor: 100n,
  });
  await insertProduct({
    id: fixtures.foreignArchived,
    companyId: kitIdentities.companies.b,
    name: "Secret Foreign Archive",
    basePriceMinor: 50n,
    status: "archived",
  });
  await insertProduct({
    id: fixtures.otherRedProduct,
    companyId: kitIdentities.companies.a,
    name: "Other Red Host",
    basePriceMinor: 10n,
  });
  await insertProduct({
    id: fixtures.retiredBox,
    companyId: kitIdentities.companies.a,
    name: "Retired Box",
    basePriceMinor: 20n,
  });
  await insertProduct({
    id: fixtures.macarons,
    companyId: kitIdentities.companies.a,
    name: "Macarons",
    basePriceMinor: 300n,
  });

  await kit.db.runtime.db.insert(productVariants).values([
    {
      id: fixtures.variantRed,
      companyId: kitIdentities.companies.a,
      productId: fixtures.coat,
      name: "Red",
    },
    {
      id: fixtures.variantBlue,
      companyId: kitIdentities.companies.a,
      productId: fixtures.coat,
      name: "Blue",
    },
    {
      id: fixtures.variantArchived,
      companyId: kitIdentities.companies.a,
      productId: fixtures.coat,
      name: "Vintage",
      status: "archived",
    },
    {
      id: fixtures.variantOtherRed,
      companyId: kitIdentities.companies.a,
      productId: fixtures.otherRedProduct,
      name: "Red",
    },
    {
      id: fixtures.variantForeign,
      companyId: kitIdentities.companies.b,
      productId: fixtures.foreign,
      name: "Red",
    },
    {
      id: fixtures.variantRetired,
      companyId: kitIdentities.companies.a,
      productId: fixtures.retiredBox,
      name: "Old Filling",
      status: "archived",
    },
    {
      id: fixtures.variantArchivedVariable,
      companyId: kitIdentities.companies.a,
      productId: fixtures.archivedVariable,
      name: "Retired Filling",
      status: "archived",
    },
    {
      id: fixtures.macaronLemon,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Lemon",
    },
    {
      id: fixtures.macaronChocolate,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Chocolate",
    },
    {
      id: fixtures.macaronVanilla,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Vanilla",
    },
    {
      id: fixtures.macaronRaspberry,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Raspberry",
    },
    {
      id: fixtures.macaronPistachio,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Pistachio",
    },
    {
      id: fixtures.macaronSaltedCaramel,
      companyId: kitIdentities.companies.a,
      productId: fixtures.macarons,
      name: "Salted Caramel",
    },
  ]);

  await kit.db.runtime.db.insert(user).values({
    id: clerkUserId,
    name: "Clerk",
    email: "clerk@catalog-resolve-lines.test",
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

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      resolveLineReferences,
      {
        input: {
          lines: [{ product: { by: "id", id: fixtures.alpha } }],
        },
      },
      {
        input: {
          lines: [{ product: { by: "id", id: fixtures.foreign } }],
        },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("catalog.resolveLineReferences", () => {
  it("resolves unique query names the same as ids and preserves input order", async () => {
    const byId = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "id", id: fixtures.zero } },
        { product: { by: "id", id: fixtures.alpha } },
      ],
    });
    const byQuery = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "query", value: "Zero" } },
        { product: { by: "query", value: "  Alpha  " } },
      ],
    });
    expect(byId.lines.map((line) => line.productId)).toEqual([
      fixtures.zero,
      fixtures.alpha,
    ]);
    expect(byQuery.lines).toEqual(byId.lines);
    expect(byId.lines).toHaveLength(2);
  });

  it("resolves simple products with unspecified or base to variantId null", async () => {
    const omitted = await kit.invoke(resolveLineReferences, {
      lines: [{ product: { by: "id", id: fixtures.alpha } }],
    });
    const unspecified = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "id", id: fixtures.alpha },
          variantSelection: { kind: "unspecified" },
        },
      ],
    });
    const base = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "id", id: fixtures.alpha },
          variantSelection: { kind: "base" },
        },
      ],
    });
    const expected = {
      productId: fixtures.alpha,
      productName: "Alpha",
      variantId: null,
      variantName: null,
    };
    expect(omitted.lines[0]).toEqual(expected);
    expect(unspecified.lines[0]).toEqual(expected);
    expect(base.lines[0]).toEqual(expected);
  });

  it("matches NFC product names and unique active variant query or id", async () => {
    const cafe = await kit.invoke(resolveLineReferences, {
      lines: [{ product: { by: "query", value: "Cafe\u0301 Cake" } }],
    });
    expect(cafe.lines[0]?.productId).toBe(fixtures.cafe);

    const coatRedQuery = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "query", value: "Coat" },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Red" },
          },
        },
      ],
    });
    const coatRedId = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "id", id: fixtures.coat },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.variantRed },
          },
        },
      ],
    });
    const expected = {
      productId: fixtures.coat,
      productName: "Coat",
      variantId: fixtures.variantRed,
      variantName: "Red",
    };
    expect(coatRedQuery.lines[0]).toEqual(expected);
    expect(coatRedId.lines[0]).toEqual(expected);
  });

  it("maps legacy variant EntityRef to reference", async () => {
    const legacy = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "query", value: "Coat" },
          variant: { by: "query", value: "Red" },
        },
      ],
    });
    expect(legacy.lines[0]).toEqual({
      productId: fixtures.coat,
      productName: "Coat",
      variantId: fixtures.variantRed,
      variantName: "Red",
    });
  });

  it("zips a mixed batch in input order", async () => {
    const resolved = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "id", id: fixtures.alpha } },
        {
          product: { by: "id", id: fixtures.coat },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: fixtures.variantBlue },
          },
        },
        { product: { by: "query", value: "Zero" } },
      ],
    });
    expect(resolved.lines).toEqual([
      {
        productId: fixtures.alpha,
        productName: "Alpha",
        variantId: null,
        variantName: null,
      },
      {
        productId: fixtures.coat,
        productName: "Coat",
        variantId: fixtures.variantBlue,
        variantName: "Blue",
      },
      {
        productId: fixtures.zero,
        productName: "Zero",
        variantId: null,
        variantName: null,
      },
    ]);
  });

  it("resolves a unique variant query without splitting a combined phrase", async () => {
    const lemon = await kit.invoke(resolveLineReferences, {
      lines: [
        {
          product: { by: "query", value: "Macarons" },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Lemon" },
          },
        },
      ],
    });
    expect(lemon.lines[0]).toEqual({
      productId: fixtures.macarons,
      productName: "Macarons",
      variantId: fixtures.macaronLemon,
      variantName: "Lemon",
    });
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Macarons Lemon" } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires an active variant for unspecified or base on a variable product", async () => {
    const unspecified = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variantSelection: { kind: "unspecified" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const omitted = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "id", id: fixtures.coat } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const base = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variantSelection: { kind: "base" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );

    for (const error of [unspecified, omitted, base]) {
      const conflict = expectResolutionConflict(error);
      expect(conflict.reason).toBe("variant_required");
      expect(conflict.target).toEqual({
        kind: "order_line_variant",
        lineIndex: 0,
        productId: fixtures.coat,
        productName: "Coat",
      });
      expect(conflict.options).toEqual([
        { id: fixtures.variantBlue, label: "Blue" },
        { id: fixtures.variantRed, label: "Red" },
      ]);
      expect(conflict.optionsTruncated).toBe(false);
      expect(conflict.options.map((option) => option.id)).not.toContain(
        fixtures.variantArchived,
      );
      expect(conflict.options.map((option) => option.id)).not.toContain(
        fixtures.variantForeign,
      );
      expect(conflict.options.map((option) => option.id)).not.toContain(
        fixtures.variantOtherRed,
      );
    }
  });

  it("returns no_active_variants for archived-only variable products", async () => {
    const unspecified = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.retiredBox },
            variantSelection: { kind: "unspecified" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const base = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.retiredBox },
            variantSelection: { kind: "base" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    for (const error of [unspecified, base]) {
      const conflict = expectResolutionConflict(error);
      expect(conflict.reason).toBe("no_active_variants");
      expect(conflict.target).toEqual({
        kind: "order_line_variant",
        lineIndex: 0,
        productId: fixtures.retiredBox,
        productName: "Retired Box",
      });
      expect(conflict.options).toEqual([]);
      expect(conflict.optionsTruncated).toBe(false);
    }
  });

  it("returns not-found for archived product or variant ids on this create-path", async () => {
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [{ product: { by: "id", id: fixtures.archived } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variantSelection: {
              kind: "reference",
              ref: { by: "id", id: fixtures.variantArchived },
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns archived for a unique archived-only query and does not resolve the line", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "old widget" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "old widget",
      productName: "Old Widget",
    });
    expect("productName" in conflict.target).toBe(true);
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.clientMessage).toBe(archivedProductMessage("Old Widget"));
    expect(conflict.clientMessage).toContain("Old Widget");
  });

  it("returns archived for an archived variable product query without selling the parent", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Archived Variable Box" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "Archived Variable Box",
      productName: "Archived Variable Box",
    });
  });

  it("returns archived with the query as subject when several archived-only products match", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "ZzzArchiveTwin" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "ZzzArchiveTwin",
    });
    expect("productName" in conflict.target).toBe(false);
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.clientMessage).toBe(
      archivedProductQueryMessage("ZzzArchiveTwin"),
    );
    expect(conflict.clientMessage).not.toContain("ZzzArchiveTwin One");
    expect(conflict.clientMessage).not.toContain("ZzzArchiveTwin Two");
  });

  it("still uniquely resolves an active query when an archived sibling has the same name", async () => {
    const resolved = await kit.invoke(resolveLineReferences, {
      lines: [{ product: { by: "query", value: "Alpha" } }],
    });
    expect(resolved.lines).toEqual([
      {
        productId: fixtures.alpha,
        productName: "Alpha",
        variantId: null,
        variantName: null,
      },
    ]);
  });

  it("still requires an active variant when an archived sibling shares the product name", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Coat" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("variant_required");
    expect(conflict.target).toEqual({
      kind: "order_line_variant",
      lineIndex: 0,
      productId: fixtures.coat,
      productName: "Coat",
    });
    expect(conflict.options.map((option) => option.id)).toEqual([
      fixtures.variantBlue,
      fixtures.variantRed,
    ]);
  });

  it("returns not-found for a variant query on a simple product, not unmatched_query", async () => {
    const selectionError = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.alpha },
            variantSelection: {
              kind: "reference",
              ref: { by: "query", value: "Lemon" },
            },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (caught: unknown) => caught,
      );
    expect(selectionError).toBeInstanceOf(NotFoundError);
    expect(selectionError).not.toBeInstanceOf(ReferenceResolutionConflictError);

    const legacyError = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.alpha },
            variant: { by: "query", value: "Lemon" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (caught: unknown) => caught,
      );
    expect(legacyError).toBeInstanceOf(NotFoundError);
    expect(legacyError).not.toBeInstanceOf(ReferenceResolutionConflictError);
  });

  it("conflicts on unmatched variant query with active options, not an empty picker", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variantSelection: {
              kind: "reference",
              ref: { by: "query", value: "Vintage" },
            },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("unmatched_query");
    expect(conflict.target).toEqual({
      kind: "order_line_variant",
      lineIndex: 0,
      productId: fixtures.coat,
      productName: "Coat",
    });
    expect(conflict.options).toEqual([
      { id: fixtures.variantBlue, label: "Blue" },
      { id: fixtures.variantRed, label: "Red" },
    ]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("conflicts on ambiguous variant names among candidates only", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variant: { by: "query", value: "e" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.options).toEqual([
      { id: fixtures.variantBlue, label: "Blue" },
      { id: fixtures.variantRed, label: "Red" },
    ]);
    expect(conflict.options.map((option) => option.id)).not.toContain(
      fixtures.variantArchived,
    );
  });

  it("uses deterministic input-order lineIndex on the first unresolved variable line", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [
          { product: { by: "id", id: fixtures.alpha } },
          {
            product: { by: "id", id: fixtures.coat },
            variantSelection: { kind: "unspecified" },
          },
          { product: { by: "id", id: fixtures.zero } },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("variant_required");
    expect(conflict.target).toEqual({
      kind: "order_line_variant",
      lineIndex: 1,
      productId: fixtures.coat,
      productName: "Coat",
    });
  });

  it("fits a six-flavour product in the picker and truncates above the named cap", async () => {
    const six = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.macarons },
            variantSelection: { kind: "unspecified" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const sixConflict = expectResolutionConflict(six);
    expect(sixConflict.options).toHaveLength(6);
    expect(sixConflict.optionsTruncated).toBe(false);
    expect(sixConflict.options.map((option) => option.label)).toEqual([
      "Chocolate",
      "Lemon",
      "Pistachio",
      "Raspberry",
      "Salted Caramel",
      "Vanilla",
    ]);

    const overflowId = randomUUID();
    await insertProduct({
      id: overflowId,
      companyId: kitIdentities.companies.a,
      name: "Overflow Box",
      basePriceMinor: 10n,
    });
    await kit.db.runtime.db.insert(productVariants).values(
      Array.from({ length: VARIANT_SELECTION_OPTIONS_MAX + 1 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        productId: overflowId,
        name: `Flavour ${String(index).padStart(2, "0")}`,
        status: "active" as const,
      })),
    );
    const overflow = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: overflowId },
            variantSelection: { kind: "unspecified" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const overflowConflict = expectResolutionConflict(overflow);
    expect(overflowConflict.options).toHaveLength(
      VARIANT_SELECTION_OPTIONS_MAX,
    );
    expect(overflowConflict.optionsTruncated).toBe(true);
  });

  it("conflicts on ambiguous product names with structured options", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "TwinCake" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "TwinCake",
    });
    expect(conflict.options).toEqual([
      { id: fixtures.twinEur, label: "TwinCake (EUR)" },
      { id: fixtures.twinUah, label: "TwinCake (UAH)" },
    ]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.options.map((option) => option.id)).not.toContain(
      fixtures.archivedTwin,
    );
    expect(conflict.clientMessage).toBe(
      ambiguousProductQueryMessage("TwinCake"),
    );
    expect(conflict.clientMessage).not.toContain("Multiple matches");
  });

  it("opens a one-option picker for a contains-only product hit and never auto-chooses", async () => {
    const macaronsId = randomUUID();
    await insertProduct({
      id: macaronsId,
      companyId: kitIdentities.companies.a,
      name: "Макаронси",
      basePriceMinor: 300n,
    });
    await kit.db.runtime.db.insert(productVariants).values([
      {
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        productId: macaronsId,
        name: "Lemon",
      },
      {
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        productId: macaronsId,
        name: "Chocolate",
      },
    ]);
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "макаронс" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "макаронс",
    });
    expect(conflict.options).toEqual([{ id: macaronsId, label: "Макаронси" }]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.clientMessage).toBe(
      ambiguousProductQueryMessage("макаронс"),
    );
    expect(conflict.clientMessage).not.toContain("Multiple matches");
  });

  it("conflicts on contains-only product hits and never auto-chooses", async () => {
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Cake" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.options.length).toBeGreaterThan(1);
    expect(conflict.options.map((option) => option.id)).not.toContain(
      fixtures.archivedTwin,
    );
    expect(conflict.clientMessage).not.toContain("Multiple matches");
  });

  it("returns not-found for missing, foreign, and mismatched variant ids", async () => {
    const missing = randomUUID();
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [{ product: { by: "id", id: missing } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [{ product: { by: "id", id: fixtures.foreign } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.coat },
            variant: { by: "id", id: fixtures.variantOtherRed },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Nobody" } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const unmatched = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Nobody" } }],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (caught: unknown) => caught,
      );
    expect(unmatched).toBeInstanceOf(NotFoundError);
    expect(unmatched).not.toBeInstanceOf(ReferenceResolutionConflictError);
  });

  it("denies staff without products:view", async () => {
    await expect(
      kit.invoke(
        resolveLineReferences,
        { lines: [{ product: { by: "id", id: fixtures.alpha } }] },
        { userId: clerkUserId, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects an empty or oversized batch and exclusive variant fields", async () => {
    await expect(
      kit.invoke(resolveLineReferences, { lines: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    const oversized = Array.from(
      { length: RESOLVE_LINE_REFERENCES_MAX_LINES + 1 },
      () => ({ product: { by: "id" as const, id: fixtures.alpha } }),
    );
    await expect(
      kit.invoke(resolveLineReferences, { lines: oversized }),
    ).rejects.toBeInstanceOf(ValidationError);
    const exclusive = await kit
      .invoke(resolveLineReferences, {
        lines: [
          {
            product: { by: "id", id: fixtures.alpha },
            variant: { by: "id", id: fixtures.variantRed },
            variantSelection: { kind: "base" },
          },
        ],
      })
      .then(
        () => {
          throw new Error("expected ValidationError");
        },
        (caught: unknown) => caught,
      );
    expect(exclusive).toBeInstanceOf(ValidationError);
    if (!(exclusive instanceof ValidationError)) {
      return;
    }
    expect(exclusive.clientMessage).toBe("Input validation failed.");
    expect(JSON.stringify(exclusive.issues)).toContain(
      VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
    );
  });

  it("does not per-line query or ctx.call", () => {
    const source = readFileSync(
      new URL("../services/resolve-line-references.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/ctx\.call\(/);
    // id + exact-name helper + per-query capped contains helper + variants.
    // Exact and contains helpers run once per status so archived rows cannot
    // consume the active candidate budget. Count Drizzle table .from(...)
    // only — not Array.from.
    expect(source.match(/\.from\((products|productVariants)\)/g)?.length).toBe(
      4,
    );
    // Declaration plus one call per status (active, archived).
    expect(source.match(/loadProductsByExactQuery\(/g)).toHaveLength(3);
    expect(source.match(/loadProductsByContainsQuery\(/g)).toHaveLength(3);
    expect(source).toMatch(/sellableProducts/);
    expect(source).toMatch(/VARIANT_SELECTION_OPTIONS_MAX/);
  });

  it("resolves a unique query-path product when the combined contains scan is capped", async () => {
    const uniqueName = "ZzzExactSurvivor";
    const uniqueId = randomUUID();
    const otherUniqueName = "ZzzOtherSurvivor";
    const otherUniqueId = randomUUID();
    await insertProduct({
      id: uniqueId,
      companyId: kitIdentities.companies.a,
      name: uniqueName,
      basePriceMinor: 10n,
    });
    await insertProduct({
      id: otherUniqueId,
      companyId: kitIdentities.companies.a,
      name: otherUniqueName,
      basePriceMinor: 10n,
    });
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `Aaa${uniqueName} ${String(index).padStart(3, "0")}`,
        basePriceMinor: 10n,
        status: "active" as const,
      })),
    );

    const resolved = await kit.invoke(resolveLineReferences, {
      lines: [
        { product: { by: "query", value: uniqueName } },
        { product: { by: "query", value: otherUniqueName } },
      ],
    });
    expect(resolved.lines).toEqual([
      {
        productId: uniqueId,
        productName: uniqueName,
        variantId: null,
        variantName: null,
      },
      {
        productId: otherUniqueId,
        productName: otherUniqueName,
        variantId: null,
        variantName: null,
      },
    ]);
  });

  it("does not drop a later contains query into NOT_FOUND after an earlier query fills 100 hits", async () => {
    const crowdingExactName = "AaaCapCrowd 000";
    const crowdingExactId = randomUUID();
    const laterContainsId = randomUUID();
    const laterContainsName = "ZzzLaterContainsTarget";
    await insertProduct({
      id: crowdingExactId,
      companyId: kitIdentities.companies.a,
      name: crowdingExactName,
      basePriceMinor: 10n,
    });
    await insertProduct({
      id: laterContainsId,
      companyId: kitIdentities.companies.a,
      name: laterContainsName,
      basePriceMinor: 10n,
    });
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `AaaCapCrowd ${String(index + 1).padStart(3, "0")}`,
        basePriceMinor: 10n,
        status: "active" as const,
      })),
    );

    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [
          { product: { by: "query", value: crowdingExactName } },
          { product: { by: "query", value: "LaterContainsTarget" } },
        ],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict).not.toBeInstanceOf(NotFoundError);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 1,
      query: "LaterContainsTarget",
    });
    expect(conflict.options).toEqual([
      { id: laterContainsId, label: laterContainsName },
    ]);
  });

  it("does not leak a foreign archived name and does not let foreign archived rows change a local match", async () => {
    const ownerError = await kit
      .invoke(
        resolveLineReferences,
        {
          lines: [
            { product: { by: "query", value: "Secret Foreign Archive" } },
          ],
        },
        {
          userId: kitIdentities.users.boris,
          companyId: kitIdentities.companies.b,
        },
      )
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const ownerConflict = expectResolutionConflict(ownerError);
    expect(ownerConflict.reason).toBe("archived");
    expect(ownerConflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "Secret Foreign Archive",
      productName: "Secret Foreign Archive",
    });

    const strangerError = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "Secret Foreign Archive" } }],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError");
        },
        (caught: unknown) => caught,
      );
    expect(strangerError).toBeInstanceOf(NotFoundError);
    expect(strangerError).not.toBeInstanceOf(ReferenceResolutionConflictError);
    if (!(strangerError instanceof NotFoundError)) {
      return;
    }
    expect(strangerError.clientMessage).toBe(
      "The requested resource was not found.",
    );
    expect(strangerError.clientMessage).not.toContain("Secret Foreign Archive");
    expect(strangerError.clientMessage.toLowerCase()).not.toContain("archived");
    expect(strangerError.message).not.toContain("Secret Foreign Archive");

    const localAlpha = await kit.invoke(resolveLineReferences, {
      lines: [{ product: { by: "query", value: "Alpha" } }],
    });
    expect(localAlpha.lines[0]?.productId).toBe(fixtures.alpha);

    const twinError = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "TwinCake" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const twinConflict = expectResolutionConflict(twinError);
    expect(twinConflict.reason).toBe("ambiguous");
    expect(twinConflict.options.map((option) => option.id)).not.toContain(
      fixtures.foreignArchived,
    );
    expect(twinConflict.options.map((option) => option.id)).not.toContain(
      fixtures.archivedTwin,
    );
  });

  it("keeps a unique archived contains-only subject named and never auto-selects", async () => {
    const archivedId = randomUUID();
    await insertProduct({
      id: archivedId,
      companyId: kitIdentities.companies.a,
      name: "Zzz Unique ArchiveContainsHost",
      basePriceMinor: 10n,
      status: "archived",
    });
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "ArchiveContainsHost" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "ArchiveContainsHost",
      productName: "Zzz Unique ArchiveContainsHost",
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("opens an active contains-only picker and ignores archived matches", async () => {
    const activeId = randomUUID();
    const archivedId = randomUUID();
    await insertProduct({
      id: activeId,
      companyId: kitIdentities.companies.a,
      name: "SHO440Contains Active",
      basePriceMinor: 10n,
    });
    await insertProduct({
      id: archivedId,
      companyId: kitIdentities.companies.a,
      name: "SHO440Contains Archived",
      basePriceMinor: 10n,
      status: "archived",
    });
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "SHO440Contains" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "SHO440Contains",
    });
    expect("productName" in conflict.target).toBe(false);
    expect(conflict.options).toEqual([
      { id: activeId, label: "SHO440Contains Active" },
    ]);
    expect(conflict.options.map((option) => option.id)).not.toContain(
      archivedId,
    );
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("does not hide an active contains match behind 100 archived contains hits", async () => {
    const activeId = randomUUID();
    await insertProduct({
      id: activeId,
      companyId: kitIdentities.companies.a,
      name: "Zzz SHO440Crowd Live",
      basePriceMinor: 10n,
    });
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `Aaa SHO440Crowd ${String(index).padStart(3, "0")}`,
        basePriceMinor: 10n,
        status: "archived" as const,
      })),
    );
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "SHO440Crowd" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "SHO440Crowd",
    });
    expect(conflict.options).toEqual([
      { id: activeId, label: "Zzz SHO440Crowd Live" },
    ]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("still names a unique archived exact match when archived contains hits fill the cap", async () => {
    const uniqueName = "ZzzSHO440ExactSurvivor";
    await insertProduct({
      id: randomUUID(),
      companyId: kitIdentities.companies.a,
      name: uniqueName,
      basePriceMinor: 10n,
      status: "archived",
    });
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `Aaa${uniqueName} ${String(index).padStart(3, "0")}`,
        basePriceMinor: 10n,
        status: "archived" as const,
      })),
    );
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: uniqueName } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: uniqueName,
      productName: uniqueName,
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("caps picker options separately from REFERENCE_CONFLICT_LABELS_MAX", async () => {
    await kit.db.runtime.db.insert(products).values(
      Array.from({ length: 6 }, (_, index) => ({
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: `MatchCap ${String(index)}`,
        basePriceMinor: 10n,
        status: "active" as const,
      })),
    );
    const error = await kit
      .invoke(resolveLineReferences, {
        lines: [{ product: { by: "query", value: "MatchCap" } }],
      })
      .then(
        () => {
          throw new Error("expected ReferenceResolutionConflictError");
        },
        (caught: unknown) => caught,
      );
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("ambiguous");
    expect(conflict.options).toHaveLength(6);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.options.map((option) => option.label)).toEqual([
      "MatchCap 0",
      "MatchCap 1",
      "MatchCap 2",
      "MatchCap 3",
      "MatchCap 4",
      "MatchCap 5",
    ]);
    expect(conflict.clientMessage).toBe(
      ambiguousProductQueryMessage("MatchCap"),
    );
    expect(conflict.clientMessage).not.toContain("Multiple matches");
  });

  it("returns archived for a later line instead of a first-line variant picker", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "query", value: "Old Widget" } },
    ]);
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 1,
      query: "Old Widget",
      productName: "Old Widget",
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("returns NOT_FOUND for a later unknown name instead of a first-line variant picker", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "query", value: "No Such Cake" } },
    ]);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(ReferenceResolutionConflictError);
  });

  it("returns no_active_variants for a later line instead of a first-line variant picker", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "id", id: fixtures.retiredBox } },
    ]);
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("no_active_variants");
    expect(conflict.target).toEqual({
      kind: "order_line_variant",
      lineIndex: 1,
      productId: fixtures.retiredBox,
      productName: "Retired Box",
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
  });

  it("still returns a line-0 terminal when a later line would open a picker", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Old Widget" } },
      { product: { by: "query", value: "Macarons" } },
    ]);
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "Old Widget",
      productName: "Old Widget",
    });
  });

  it("still returns the first picker when no terminal exists", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "id", id: fixtures.coat } },
    ]);
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("variant_required");
    expect(conflict.target).toEqual({
      kind: "order_line_variant",
      lineIndex: 0,
      productId: fixtures.macarons,
      productName: "Macarons",
    });
  });

  it("returns the earliest terminal by input index regardless of reason type", async () => {
    const archivedThenMissing = expectResolutionConflict(
      await invokeResolveFailure([
        { product: { by: "query", value: "Macarons" } },
        { product: { by: "query", value: "Old Widget" } },
        { product: { by: "query", value: "No Such Cake" } },
      ]),
    );
    expect(archivedThenMissing.reason).toBe("archived");
    expect(archivedThenMissing.target.lineIndex).toBe(1);

    const missingThenArchived = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "query", value: "No Such Cake" } },
      { product: { by: "query", value: "Old Widget" } },
    ]);
    expect(missingThenArchived).toBeInstanceOf(NotFoundError);
    expect(missingThenArchived).not.toBeInstanceOf(
      ReferenceResolutionConflictError,
    );

    const noVariantsThenArchived = expectResolutionConflict(
      await invokeResolveFailure([
        { product: { by: "query", value: "Macarons" } },
        { product: { by: "id", id: fixtures.retiredBox } },
        { product: { by: "query", value: "Old Widget" } },
      ]),
    );
    expect(noVariantsThenArchived.reason).toBe("no_active_variants");
    expect(noVariantsThenArchived.target.lineIndex).toBe(1);

    const archivedThenNoVariants = expectResolutionConflict(
      await invokeResolveFailure([
        { product: { by: "query", value: "Macarons" } },
        { product: { by: "query", value: "Old Widget" } },
        { product: { by: "id", id: fixtures.retiredBox } },
      ]),
    );
    expect(archivedThenNoVariants.reason).toBe("archived");
    expect(archivedThenNoVariants.target.lineIndex).toBe(1);
  });

  it("preserves original line indices and archived metadata on mixed-cart terminals", async () => {
    const error = await invokeResolveFailure([
      { product: { by: "query", value: "Macarons" } },
      { product: { by: "id", id: fixtures.alpha } },
      { product: { by: "query", value: "old widget" } },
    ]);
    const conflict = expectResolutionConflict(error);
    expect(conflict.reason).toBe("archived");
    expect(conflict.target).toEqual({
      kind: "order_line_product",
      lineIndex: 2,
      query: "old widget",
      productName: "Old Widget",
    });
    expect(conflict.options).toEqual([]);
    expect(conflict.optionsTruncated).toBe(false);
    expect(conflict.clientMessage).toBe(archivedProductMessage("Old Widget"));
  });

  it("propagates unexpected invariant errors instead of an earlier picker or NOT_FOUND", async () => {
    const invariantLine: LineReferenceInput = {
      product: { by: "id", id: fixtures.alpha },
      get variantSelection(): VariantSelection {
        throw new CoreInvariantError("catalog resolve test invariant");
      },
    };
    const caught = await resolveCatalogLineReferences({
      db: staffReadDb(),
      companyId: kitIdentities.companies.a,
      lines: [{ product: { by: "query", value: "Macarons" } }, invariantLine],
    }).then(
      () => {
        throw new Error("expected CoreInvariantError");
      },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(CoreInvariantError);
    expect(caught).not.toBeInstanceOf(NotFoundError);
    expect(caught).not.toBeInstanceOf(ReferenceResolutionConflictError);
    if (!(caught instanceof CoreInvariantError)) {
      return;
    }
    expect(caught.clientMessage).toBe("Internal error.");
  });

  it("keeps catalog reads bounded as line count grows and preserves input order", async () => {
    const unit: LineReferenceInput[] = [
      { product: { by: "id", id: fixtures.alpha } },
      { product: { by: "query", value: "Zero" } },
      {
        product: { by: "id", id: fixtures.coat },
        variantSelection: {
          kind: "reference",
          ref: { by: "id", id: fixtures.variantRed },
        },
      },
    ];
    const short = unit;
    const long = Array.from({ length: 8 }, () => unit).flat();

    const shortRun = await collectStatements(() =>
      kit.invoke(resolveLineReferences, { lines: short }),
    );
    expect(shortRun.outcome.status).toBe("fulfilled");
    const longRun = await collectStatements(() =>
      kit.invoke(resolveLineReferences, { lines: long }),
    );
    expect(longRun.outcome.status).toBe("fulfilled");
    if (
      shortRun.outcome.status !== "fulfilled" ||
      longRun.outcome.status !== "fulfilled"
    ) {
      return;
    }

    const shortCatalogReads = catalogReadStatementCount(shortRun.statements);
    const longCatalogReads = catalogReadStatementCount(longRun.statements);
    expect(shortCatalogReads).toBeGreaterThan(0);
    expect(shortCatalogReads).toBeLessThanOrEqual(6);
    expect(longCatalogReads).toBe(shortCatalogReads);
    expect(longCatalogReads).toBeLessThan(long.length);

    const shortLines = shortRun.outcome.value.lines;
    const longLines = longRun.outcome.value.lines;
    expect(shortLines).toEqual([
      {
        productId: fixtures.alpha,
        productName: "Alpha",
        variantId: null,
        variantName: null,
      },
      {
        productId: fixtures.zero,
        productName: "Zero",
        variantId: null,
        variantName: null,
      },
      {
        productId: fixtures.coat,
        productName: "Coat",
        variantId: fixtures.variantRed,
        variantName: "Red",
      },
    ]);
    expect(longLines).toHaveLength(long.length);
    expect(longLines).toEqual(
      Array.from({ length: 8 }, () => shortLines).flat(),
    );
  });
});
