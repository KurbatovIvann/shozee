import {
  SHO_CONTEXT_LIMITS,
  SHO_MAX_CONTEXT_BYTES,
  shoContextSchema,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import {
  buildShoContext,
  type ShoCatalogNameIndex,
  type ShoNameEntry,
  type ShoNameIndexSnapshot,
  type ShoVariantEntry,
} from "./sho-context.js";

const id = (prefix: string, index: number): string =>
  `${prefix}-${String(index).padStart(6, "0")}`;

const entries = (prefix: string, count: number): ShoNameEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    id: id(prefix, index),
    name: `${prefix} ${String(index)}`,
  }));

const list = <Item extends ShoNameEntry>(
  items: readonly Item[],
  truncated = false,
) => ({ items, truncated });

const catalogOf = (
  products: readonly ShoNameEntry[],
  variants: readonly ShoVariantEntry[],
): ShoCatalogNameIndex => ({
  products: list(products),
  variants: list(variants),
});

const snapshot = (
  overrides: Partial<ShoNameIndexSnapshot> = {},
): ShoNameIndexSnapshot => ({
  catalog: catalogOf(entries("product", 2), [
    { id: "variant-1", productId: id("product", 0), name: "Кава / 1 кг" },
  ]),
  customers: {
    customers: list(entries("customer", 2)),
    groups: list(entries("group", 2)),
  },
  pricing: { priceLists: list(entries("price-list", 2)) },
  ...overrides,
});

describe("buildShoContext", () => {
  it("sends ids and names with the stock and fiscal capabilities off", () => {
    const built = buildShoContext(snapshot());

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    expect(built.context.capabilities).toEqual({ stock: false, fiscal: false });
    expect(built.context.customers?.map((record) => record.name)).toEqual([
      "customer 0",
      "customer 1",
    ]);
    expect(built.context.groups).toHaveLength(2);
    expect(built.context.priceLists).toHaveLength(2);
    expect(built.context.partial).toBeUndefined();
  });

  it("leaves brand, unit and variant values unsent", () => {
    const built = buildShoContext(snapshot());
    const [first, second] = built.context.products ?? [];

    expect(Object.keys(first ?? {}).sort()).toEqual(["id", "name", "variants"]);
    expect(Object.keys(second ?? {}).sort()).toEqual(["id", "name"]);
    expect(Object.keys(first?.variants?.[0] ?? {}).sort()).toEqual([
      "id",
      "name",
    ]);
  });

  it("names the revision after the fingerprint and changes it with a name", () => {
    const built = buildShoContext(snapshot());
    const again = buildShoContext(snapshot());
    const renamed = buildShoContext(
      snapshot({
        pricing: {
          priceLists: list([{ id: id("price-list", 0), name: "Опт" }]),
        },
      }),
    );

    expect(built.context.revision).toBe(built.fingerprint);
    expect(again.fingerprint).toBe(built.fingerprint);
    expect(renamed.fingerprint).not.toBe(built.fingerprint);
  });

  it("hashes the scope the staff member may see", () => {
    const full = buildShoContext(snapshot());
    const withoutPricing = buildShoContext(snapshot({ pricing: null }));

    expect(withoutPricing.context.priceLists).toBeUndefined();
    expect(withoutPricing.scopeHash).not.toBe(full.scopeHash);
    expect(buildShoContext(snapshot({ pricing: null })).scopeHash).toBe(
      withoutPricing.scopeHash,
    );
  });

  it("marks a list the read truncated as partial", () => {
    const built = buildShoContext(
      snapshot({
        pricing: { priceLists: list(entries("price-list", 1), true) },
      }),
    );

    expect(built.context.partial).toEqual(["priceLists"]);
  });

  it("drops a blank or repeated name instead of failing the context", () => {
    const built = buildShoContext(
      snapshot({
        customers: {
          customers: list([
            { id: "customer-1", name: "Оля" },
            { id: "customer-1", name: "Оля again" },
            { id: "customer-2", name: "   " },
          ]),
          groups: list([]),
        },
      }),
    );

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    expect(built.context.customers).toEqual([
      { id: "customer-1", name: "Оля" },
    ]);
    expect(built.context.partial).toEqual(["customers"]);
  });

  it("clips an oversized company to the runtime limits", () => {
    const products = entries("product", 1);
    const built = buildShoContext(
      snapshot({
        catalog: catalogOf(
          products,
          Array.from(
            { length: SHO_CONTEXT_LIMITS.variantsPerProduct + 100 },
            (_, index) => ({
              id: id("variant", index),
              productId: id("product", 0),
              name: `Варіант ${String(index)}`,
            }),
          ),
        ),
        customers: {
          customers: list(entries("customer", 1)),
          groups: list(entries("group", SHO_CONTEXT_LIMITS.groups + 1_000)),
        },
      }),
    );

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    expect(built.context.products?.[0]?.variants).toHaveLength(
      SHO_CONTEXT_LIMITS.variantsPerProduct,
    );
    expect(built.context.groups).toHaveLength(SHO_CONTEXT_LIMITS.groups);
    expect(built.context.partial).toEqual(["products", "groups"]);
  });

  it("sheds until the upload fits the byte limit", () => {
    const long = "я".repeat(SHO_CONTEXT_LIMITS.name);
    const built = buildShoContext(
      snapshot({
        catalog: null,
        customers: {
          customers: list(
            Array.from(
              { length: SHO_CONTEXT_LIMITS.customers },
              (_, index) => ({
                id: id("customer", index),
                name: `${String(index)}${long}`,
              }),
            ),
          ),
          groups: list([]),
        },
        pricing: null,
      }),
    );

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    const bytes = Buffer.byteLength(JSON.stringify(built.context), "utf8");
    expect(bytes).toBeLessThan(SHO_MAX_CONTEXT_BYTES);
    expect(built.context.customers?.length).toBeGreaterThan(0);
    expect(built.context.partial).toEqual(["customers"]);
  });
});
