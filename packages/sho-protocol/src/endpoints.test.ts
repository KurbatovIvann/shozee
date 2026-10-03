import { describe, expect, it } from "vitest";

import {
  SHO_CONTEXT_LIMITS,
  SHO_CONTEXT_LIST_NAMES,
  SHO_MOST_FOCUS,
  shoContextSchema,
  shoParseRequestSchema,
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

  it("rejects a contact or a legal identifier on every context list", () => {
    const refused = {
      phones: ["+380501112233"],
      emails: ["olya@example.com"],
      phone: "+380501112233",
      email: "olya@example.com",
      edrpou: "14360570",
      iban: "UA213223130000026007233566001",
      legalAddress: "Київ, вул. Хрещатик 1",
      bankName: "ПриватБанк",
      bankMfo: "305299",
    };

    for (const list of SHO_CONTEXT_LIST_NAMES) {
      for (const [field, value] of Object.entries(refused)) {
        expect(
          parse({
            ...base,
            [list]: [{ id: "x1", name: "Оля", [field]: value }],
          }).success,
          `${list}.${field}`,
        ).toBe(false);
      }
    }
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

describe("the focus a parse request may carry", () => {
  const entry = {
    type: "customer",
    id: "11111111-1111-4111-8111-111111111111",
    name: "Катя",
    how: "created",
    turns: 0,
  };

  const asked = (focus: unknown) =>
    shoParseRequestSchema.safeParse({
      requestId: "r1",
      companyId: "c1",
      contextKey: "c1:abc",
      fingerprint: "f1",
      text: "створи для неї замовлення",
      now: { year: 2026, month: 10, day: 2, hour: 9, minute: 0 },
      focus,
      deadlineMs: 900,
      debug: false,
    });

  it("is optional, so a host that derives none still parses", () => {
    const parsed = shoParseRequestSchema.safeParse({
      requestId: "r1",
      companyId: "c1",
      contextKey: "c1:abc",
      fingerprint: "f1",
      text: "покажи клієнтів",
      now: { year: 2026, month: 10, day: 2, hour: 9, minute: 0 },
      deadlineMs: 900,
      debug: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("takes a record with its list kind, its id, its name and how it was touched", () => {
    expect(asked([entry]).success).toBe(true);
    expect(asked([{ ...entry, earlier: true }]).success).toBe(true);
    expect(
      asked([{ type: "customer", id: "", name: "", how: "listed", count: 7 }])
        .success,
    ).toBe(true);
  });

  it("carries no contact of the person it names", () => {
    expect(asked([{ ...entry, phone: "+380501112233" }]).success).toBe(false);
    expect(asked([{ ...entry, email: "kate@ukr.net" }]).success).toBe(false);
  });

  it("holds at most the records the runtime reads", () => {
    const many = Array.from({ length: SHO_MOST_FOCUS }, (_, index) => ({
      ...entry,
      id: `c-${String(index)}`,
    }));
    expect(asked(many).success).toBe(true);
    expect(asked([...many, { ...entry, id: "c-last" }]).success).toBe(false);
  });

  it("refuses a kind, a touch or a name the runtime would not take", () => {
    expect(asked([{ ...entry, type: "invoice" }]).success).toBe(false);
    expect(asked([{ ...entry, how: "whispered" }]).success).toBe(false);
    expect(asked([{ ...entry, turns: -1 }]).success).toBe(false);
    expect(
      asked([{ ...entry, name: "n".repeat(SHO_CONTEXT_LIMITS.name + 1) }])
        .success,
    ).toBe(false);
  });
});
