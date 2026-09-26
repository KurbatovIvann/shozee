import { describe, expect, it } from "vitest";

import {
  ENTITY_REF_QUERY_MAX,
  REFERENCE_CONFLICT_LABELS_MAX,
  candidatesContainingQuery,
  entityRefSchema,
  formatReferenceConflictMessage,
  isInflectionOfName,
  isInflectionOfWord,
  normalizeReferenceQuery,
  normalizeUniqueMatchQuery,
  pickUniqueNormalizedMatch,
  pickUniqueReferenceMatch,
} from "./entity-ref.js";

describe("@showzy/validation/entity-ref", () => {
  it("accepts id or query refs and rejects extras", () => {
    expect(
      entityRefSchema.parse({
        by: "id",
        id: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      by: "id",
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(entityRefSchema.parse({ by: "query", value: "  Katya  " })).toEqual({
      by: "query",
      value: "Katya",
    });
    expect(entityRefSchema.safeParse({ by: "id" }).success).toBe(false);
    expect(
      entityRefSchema.safeParse({ by: "query", value: "   " }).success,
    ).toBe(false);
    expect(
      entityRefSchema.safeParse({
        by: "query",
        value: "x".repeat(ENTITY_REF_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      entityRefSchema.safeParse({
        by: "id",
        id: "11111111-1111-4111-8111-111111111111",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("normalizes NFC, trim, collapsed whitespace, and case-fold", () => {
    expect(normalizeReferenceQuery("  Cafe\u0301   Cake ")).toBe("Café Cake");
    expect(normalizeUniqueMatchQuery("  Cafe\u0301   Cake ")).toBe("café cake");
    expect(normalizeUniqueMatchQuery("KATYA")).toBe("katya");
  });

  it("writes on a unique exact match and conflicts on contains-only", () => {
    const rows = [
      { name: "Katya", phone: "+380501111111" },
      { name: "Katya Keks", phone: "+380502222222" },
    ];
    const fields = (row: (typeof rows)[number]) => [row.name, row.phone];
    expect(pickUniqueNormalizedMatch("Katya", rows, fields)).toEqual({
      kind: "unique",
      row: rows[0],
    });
    expect(pickUniqueNormalizedMatch("Katya Keks", rows, fields).kind).toBe(
      "unique",
    );
    expect(pickUniqueNormalizedMatch("Kat", rows, fields)).toEqual({
      kind: "ambiguous",
      rows,
    });
    expect(pickUniqueNormalizedMatch("nobody", [], fields)).toEqual({
      kind: "none",
    });
    const scoped = candidatesContainingQuery("Katya Keks", rows, fields);
    expect(pickUniqueNormalizedMatch("Katya Keks", scoped, fields).kind).toBe(
      "unique",
    );
  });

  it("caps conflict labels at five", () => {
    expect(REFERENCE_CONFLICT_LABELS_MAX).toBe(5);
    const message = formatReferenceConflictMessage("Katya", [
      "A (…1111)",
      "B (…2222)",
      "C (…3333)",
      "D (…4444)",
      "E (…5555)",
      "F (…6666)",
    ]);
    expect(message).toContain("A (…1111)");
    expect(message).toContain("E (…5555)");
    expect(message).not.toContain("F (…6666)");
  });
});

describe("reference inflection", () => {
  it("accepts an oblique case of the same word and rejects a different word", () => {
    expect(isInflectionOfWord("олени", "олена")).toBe(true);
    expect(isInflectionOfWord("шевчука", "шевчук")).toBe(true);
    expect(isInflectionOfWord("коваля", "коваль")).toBe(true);
    expect(isInflectionOfWord("марію", "марія")).toBe(true);
    expect(isInflectionOfWord("петренка", "петренко")).toBe(true);
    expect(isInflectionOfWord("шевчука", "шевчун")).toBe(false);
    expect(isInflectionOfWord("олени", "олеся")).toBe(false);
    expect(isInflectionOfWord("петренка", "петрук")).toBe(false);
    expect(isInflectionOfWord("anna", "anne")).toBe(false);
  });

  it("needs the same number of words, in any order", () => {
    expect(isInflectionOfName("Олени Петренко", "Олена Петренко")).toBe(true);
    expect(isInflectionOfName("шевчука ігоря", "Ігор Шевчук")).toBe(true);
    expect(isInflectionOfName("петренка", "Олена Петренко")).toBe(false);
    expect(isInflectionOfName("олени петренко", "Олена Петрук")).toBe(false);
  });

  const rows = [
    { id: "1", name: "Олена Петренко", phone: "0671000001" },
    { id: "2", name: "Олена Петрук", phone: "0671000002" },
  ];
  const fields = (row: (typeof rows)[number]) => [row.name, row.phone];
  const name = (row: (typeof rows)[number]) => row.name;

  it("writes on a unique inflected name when nothing is exact", () => {
    expect(
      pickUniqueReferenceMatch("олени петренко", rows, fields, name),
    ).toEqual({ kind: "unique", row: rows[0] });
  });

  it("keeps the exact rule first and never auto-chooses a loose candidate", () => {
    expect(pickUniqueReferenceMatch("0671000002", rows, fields, name)).toEqual({
      kind: "unique",
      row: rows[1],
    });
    expect(pickUniqueReferenceMatch("олена", rows, fields, name)).toEqual({
      kind: "ambiguous",
      rows,
    });
    expect(
      pickUniqueReferenceMatch("олена питренко", rows, fields, name),
    ).toEqual({ kind: "ambiguous", rows });
    expect(pickUniqueReferenceMatch("олени", [], fields, name)).toEqual({
      kind: "none",
    });
  });
});
