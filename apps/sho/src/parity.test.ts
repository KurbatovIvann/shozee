import {
  CONTEXT_LIMITS,
  RECORD_LISTS,
  SALE_UNITS,
  parseContext,
} from "@showzy/sho";
import {
  SHO_CONTEXT_LIMITS,
  SHO_CONTEXT_LIST_NAMES,
  SHO_MAX_CONTEXT_BYTES,
  SHO_SALE_UNITS,
  shoContextSchema,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

const records = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index)}`,
    name: `${prefix} ${String(index)}`,
  }));

const of = (length: number) => "n".repeat(length);

const ACCEPTED: readonly [string, unknown][] = [
  ["bare", { version: 2 }],
  [
    "every list and flag",
    {
      version: 2,
      revision: of(SHO_CONTEXT_LIMITS.revision),
      capabilities: { stock: false, fiscal: true },
      products: records(2, "p"),
      customers: records(2, "c"),
      groups: records(2, "g"),
      priceLists: records(2, "l"),
      counterparties: records(2, "k"),
      partial: [...SHO_CONTEXT_LIST_NAMES],
    },
  ],
  [
    "brand, unit, aliases and variants at the caps",
    {
      version: 2,
      products: [
        {
          id: of(SHO_CONTEXT_LIMITS.id),
          name: of(SHO_CONTEXT_LIMITS.name),
          brand: "Lavazza",
          unit: "kg",
          aliases: Array.from(
            { length: SHO_CONTEXT_LIMITS.aliases },
            (_, i) => `alias ${String(i)}`,
          ),
          variants: records(SHO_CONTEXT_LIMITS.variantsPerProduct, "v"),
        },
      ],
    },
  ],
  [
    "variant values as a list and as an object",
    {
      version: 2,
      products: [
        {
          id: "p",
          name: "Кава",
          variants: [
            { id: "v1", name: "250 г", values: ["250 г"] },
            { id: "v2", name: "1 кг", values: { weight: "1 кг" } },
          ],
        },
      ],
    },
  ],
  ...SHO_SALE_UNITS.map((unit): [string, unknown] => [
    `unit ${unit}`,
    { version: 2, products: [{ id: "p", name: "Кава", unit }] },
  ]),
];

const REFUSED: readonly [string, unknown][] = [
  ["a blank name", { version: 2, products: [{ id: "p", name: "  " }] }],
  ["a blank id", { version: 2, customers: [{ id: " ", name: "A" }] }],
  [
    "a blank brand",
    { version: 2, products: [{ id: "p", name: "A", brand: " " }] },
  ],
  [
    "an unknown unit",
    { version: 2, products: [{ id: "p", name: "A", unit: "barrel" }] },
  ],
  [
    "a duplicate product id",
    {
      version: 2,
      products: [
        { id: "p", name: "A" },
        { id: "p", name: "B" },
      ],
    },
  ],
  [
    "a duplicate variant id",
    {
      version: 2,
      products: [
        {
          id: "p",
          name: "A",
          variants: [
            { id: "v", name: "1" },
            { id: "v", name: "2" },
          ],
        },
      ],
    },
  ],
  [
    "a duplicate customer id",
    { version: 2, customers: records(2, "c").map((r) => ({ ...r, id: "c" })) },
  ],
  [
    "too many groups",
    { version: 2, groups: records(SHO_CONTEXT_LIMITS.groups + 1, "g") },
  ],
  [
    "too many variants on one product",
    {
      version: 2,
      products: [
        {
          id: "p",
          name: "A",
          variants: records(SHO_CONTEXT_LIMITS.variantsPerProduct + 1, "v"),
        },
      ],
    },
  ],
  [
    "too many aliases",
    {
      version: 2,
      customers: [
        {
          id: "c",
          name: "A",
          aliases: Array.from(
            { length: SHO_CONTEXT_LIMITS.aliases + 1 },
            () => "a",
          ),
        },
      ],
    },
  ],
  [
    "a name over the limit",
    {
      version: 2,
      customers: [{ id: "c", name: of(SHO_CONTEXT_LIMITS.name + 1) }],
    },
  ],
  [
    "an id over the limit",
    {
      version: 2,
      customers: [{ id: of(SHO_CONTEXT_LIMITS.id + 1), name: "A" }],
    },
  ],
  [
    "a revision over the limit",
    { version: 2, revision: of(SHO_CONTEXT_LIMITS.revision + 1) },
  ],
  ["an unknown list in partial", { version: 2, partial: ["orders"] }],
  ["an unknown key", { version: 2, variants: ["250 г"] }],
];

describe("@showzy/sho-protocol and the Шо runtime agree on the context", () => {
  it("names the same lists", () => {
    expect([...SHO_CONTEXT_LIST_NAMES]).toEqual(["products", ...RECORD_LISTS]);
  });

  it("names the same sale units", () => {
    expect([...SHO_SALE_UNITS]).toEqual([...SALE_UNITS]);
  });

  it("holds the same limits under the same keys", () => {
    const runtimeLimits: Readonly<Record<string, number>> = CONTEXT_LIMITS;
    for (const [key, value] of Object.entries(SHO_CONTEXT_LIMITS)) {
      expect([key, value]).toEqual([key, runtimeLimits[key]]);
    }
    expect(Object.keys(CONTEXT_LIMITS).toSorted()).toEqual(
      [
        ...Object.keys(SHO_CONTEXT_LIMITS),
        "bytes",
        "contact",
        "contacts",
      ].toSorted(),
    );
    expect(SHO_MAX_CONTEXT_BYTES).toBe(CONTEXT_LIMITS.bytes);
  });

  it.each(ACCEPTED)("accepts %s on both sides", (_name, context) => {
    expect(shoContextSchema.safeParse(context).success).toBe(true);
    expect(() => parseContext(context)).not.toThrow();
  });

  it.each(REFUSED)("refuses %s on both sides", (_name, context) => {
    expect(shoContextSchema.safeParse(context).success).toBe(false);
    expect(() => parseContext(context)).toThrow();
  });
});
