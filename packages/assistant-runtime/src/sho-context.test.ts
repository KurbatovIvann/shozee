import {
  SHO_CONTEXT_LIMITS,
  SHO_MAX_CONTEXT_BYTES,
  shoCommandSchema,
  shoContextSchema,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import {
  cloneShoParse,
  shoCustomerWriteParse,
} from "./sho-planners/__tests__/customer-write-parses.js";
import { SHO_CUSTOMER_WRITE_PLANNERS } from "./sho-planners/customers-writes.js";
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
    counterparties: list(entries("counterparty", 2)),
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
    expect(built.context.counterparties).toEqual([
      { id: id("counterparty", 0), name: "counterparty 0" },
      { id: id("counterparty", 1), name: "counterparty 1" },
    ]);
    expect(built.context.partial).toBeUndefined();
  });

  it("marks a list the read cut below the builder's own cap as partial", () => {
    const read = entries("counterparty", 1);
    const built = buildShoContext(
      snapshot({
        customers: {
          customers: list(entries("customer", 1)),
          groups: list([]),
          counterparties: list(read, true),
        },
      }),
    );

    expect(read.length).toBeLessThan(SHO_CONTEXT_LIMITS.counterparties);
    expect(built.context.counterparties).toHaveLength(read.length);
    expect(built.context.partial).toEqual(["counterparties"]);
  });

  it("clips the counterparties at the runtime limit", () => {
    const built = buildShoContext(
      snapshot({
        customers: {
          customers: list([]),
          groups: list([]),
          counterparties: list(
            entries("counterparty", SHO_CONTEXT_LIMITS.counterparties + 10),
          ),
        },
      }),
    );

    expect(shoContextSchema.parse(built.context)).toEqual(built.context);
    expect(built.context.counterparties).toHaveLength(
      SHO_CONTEXT_LIMITS.counterparties,
    );
    expect(built.context.partial).toEqual(["counterparties"]);
  });

  it("leaves the counterparties out when the customers scope is unseen", () => {
    const built = buildShoContext(snapshot({ customers: null }));

    expect(built.context.counterparties).toBeUndefined();
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
          counterparties: list([]),
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
          counterparties: list(entries("counterparty", 1)),
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
          counterparties: list([]),
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

const NECHYPORUK = "b18c7e52-30d9-4a66-8f21-5c90e4a7b3d6";

const CONFIDENT = { action: 0.99, margin: 0.8, certainty: 0.9, spans: 0.9 };

const PLANNED_AT = new Date("2026-10-03T12:00:00.000Z");

function counterpartyCommand(caseId: string, counterpartyId: string) {
  const parse = cloneShoParse(shoCustomerWriteParse(caseId));
  const params = parse["params"] as Record<string, Record<string, unknown>>;
  const said = params["counterparty"];
  if (said === undefined) {
    throw new Error(`${caseId} names no counterparty`);
  }
  return shoCommandSchema.parse({
    ...parse,
    confidence: CONFIDENT,
    params: { ...params, counterparty: { ...said, id: counterpartyId } },
  });
}

describe("the counterparties the builder publishes", () => {
  it("carry the ids a counterparty write planner plans on", () => {
    const built = buildShoContext(
      snapshot({
        customers: {
          customers: list([]),
          groups: list([]),
          counterparties: list([
            { id: NECHYPORUK, name: "ФОП Нечипорук Галина" },
          ]),
        },
      }),
    );

    expect(built.context.counterparties).toEqual([
      { id: NECHYPORUK, name: "ФОП Нечипорук Галина" },
    ]);

    const command = counterpartyCommand("d79-counterparty-rest", NECHYPORUK);

    expect(
      SHO_CUSTOMER_WRITE_PLANNERS[command.action]?.plan(command, PLANNED_AT),
    ).toEqual({
      kind: "call",
      toolName: "customers_updateCounterparty",
      reply: "Контрагента оновлено.",
      input: { id: NECHYPORUK, phone: "0501112233" },
    });
  });
});
