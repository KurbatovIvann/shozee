import { describe, expect, it } from "vitest";

import {
  SHO_CONTEXT_LIST_NAMES,
  shoContextSchema,
  type ShoContextListName,
} from "./endpoints.js";

const base = { version: 2 } as const;

const parse = (context: unknown) => shoContextSchema.safeParse(context);

describe("shoContextSchema products", () => {
  it("keeps the brand, the sale unit and the variant values the runtime reads", () => {
    const parsed = parse({
      ...base,
      products: [
        {
          id: "p1",
          name: "Фарба",
          brand: "Dulux",
          unit: "l",
          variants: [
            { id: "v1", name: "Біла 5 л", values: { Колір: "біла" } },
            { id: "v2", name: "Сіра 5 л", values: ["сіра", "5 л"] },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const product = parsed.data.products?.[0];
    expect(product?.brand).toBe("Dulux");
    expect(product?.unit).toBe("l");
    expect(product?.variants?.[0]?.values).toEqual({ Колір: "біла" });
    expect(product?.variants?.[1]?.values).toEqual(["сіра", "5 л"]);
  });

  it("still rejects a customer's phones and e-mails", () => {
    expect(
      parse({
        ...base,
        customers: [{ id: "c1", name: "Оля", phones: ["+380501112233"] }],
      }).success,
    ).toBe(false);
    expect(
      parse({
        ...base,
        customers: [{ id: "c1", name: "Оля", emails: ["olya@example.com"] }],
      }).success,
    ).toBe(false);
  });

  it("rejects a product field the runtime does not accept", () => {
    expect(
      parse({ ...base, products: [{ id: "p1", name: "Фарба", sku: "A-1" }] })
        .success,
    ).toBe(false);
  });

  it("rejects values that are neither a list nor a map of strings", () => {
    expect(
      parse({
        ...base,
        products: [
          {
            id: "p1",
            name: "Фарба",
            variants: [{ id: "v1", name: "Біла", values: 5 }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("shoContextSchema partial", () => {
  it("accepts every list the context carries and nothing else", () => {
    expect(
      parse({ ...base, partial: [...SHO_CONTEXT_LIST_NAMES] }).success,
    ).toBe(true);
    expect(parse({ ...base, partial: ["orders"] }).success).toBe(false);
  });

  it("names exactly the lists shoContextSchema declares", () => {
    const meta = ["version", "revision", "capabilities", "partial"];
    expect(
      Object.keys(shoContextSchema.shape)
        .filter((key) => !meta.includes(key))
        .sort(),
    ).toEqual([...SHO_CONTEXT_LIST_NAMES].sort());
  });

  it("types a parsed partial as the list-name union", () => {
    const parsed = parse({ ...base, partial: ["products"] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const names: ShoContextListName[] = [...(parsed.data.partial ?? [])];
    expect(names).toEqual(["products"]);
  });
});
