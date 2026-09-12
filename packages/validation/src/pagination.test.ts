import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCursorCodec,
  likeContainsPattern,
  listCursorInput,
  listLimitInput,
  listSearchInput,
  nameSearchStems,
  paginate,
  sanitizeLikeLiteral,
} from "./pagination.js";

function nameContainsEveryStem(
  name: string,
  stems: readonly string[],
): boolean {
  const folded = name.toLocaleLowerCase("uk");
  return stems.every((stem) => folded.includes(stem.toLocaleLowerCase("uk")));
}

const ID = "11111111-1111-4111-8111-111111111111";

describe("@showzy/validation/pagination", () => {
  describe("createCursorCodec", () => {
    const isoId = createCursorCodec({
      payload: z.object({
        createdAt: z.iso.datetime(),
        id: z.uuid(),
      }),
      fields: [
        { key: "createdAt", kind: "isoDatetime" },
        { key: "id", kind: "uuid" },
      ],
    });

    it("round-trips an ISO datetime and uuid", () => {
      const createdAt = new Date("2026-03-01T00:00:00.000Z");
      const cursor = isoId.encode({ createdAt, id: ID });
      expect(cursor).toBe(
        "2026-03-01T00:00:00.000Z|11111111-1111-4111-8111-111111111111",
      );
      expect(isoId.decode(cursor)).toEqual({
        createdAt: "2026-03-01T00:00:00.000Z",
        id: ID,
      });
    });

    it("encodes exactly three fractional digits", () => {
      const cursor = isoId.encode({
        createdAt: new Date("2026-03-01T00:00:00.123Z"),
        id: ID,
      });

      expect(cursor.split("|")[0]).toBe("2026-03-01T00:00:00.123Z");
    });

    it("rejects tampered datetime/uuid cursors", () => {
      expect(isoId.decode("nope")).toBeUndefined();
      expect(isoId.decode("2026-03-01T00:00:00.000Z")).toBeUndefined();
      expect(
        isoId.decode(`2026-03-01T00:00:00.000Z|${ID}|extra`),
      ).toBeUndefined();
      expect(
        isoId.decode(`2026-03-01T00:00:00.000Z|not-a-uuid`),
      ).toBeUndefined();
      expect(isoId.decode(`not-a-date|${ID}`)).toBeUndefined();
    });

    const named = createCursorCodec({
      payload: z.object({
        isDefault: z.boolean(),
        id: z.uuid(),
        name: z.string().min(1).max(120),
      }),
      fields: [
        { key: "isDefault", kind: "booleanFlag" },
        { key: "id", kind: "uuid" },
        { key: "name", kind: "remainder" },
      ],
    });

    it("round-trips a remainder name that contains a pipe", () => {
      const cursor = named.encode({
        isDefault: false,
        id: ID,
        name: "C|Special",
      });
      expect(named.decode(cursor)).toEqual({
        isDefault: false,
        id: ID,
        name: "C|Special",
      });
    });

    it("rejects a tampered boolean flag", () => {
      expect(named.decode(`2|${ID}|Default`)).toBeUndefined();
      expect(named.decode(`true|${ID}|Default`)).toBeUndefined();
      expect(named.decode(`1|not-a-uuid|Default`)).toBeUndefined();
    });

    const ordered = createCursorCodec({
      payload: z.object({
        sortOrder: z.number().int(),
        id: z.uuid(),
        name: z.string().min(1).max(120),
      }),
      fields: [
        { key: "sortOrder", kind: "int" },
        { key: "id", kind: "uuid" },
        { key: "name", kind: "remainder" },
      ],
    });

    it("round-trips an int/id/name cursor", () => {
      const cursor = ordered.encode({
        sortOrder: 2,
        id: ID,
        name: "C|Special",
      });
      expect(ordered.decode(cursor)).toEqual({
        sortOrder: 2,
        id: ID,
        name: "C|Special",
      });
      expect(ordered.decode(`x|${ID}|VIP`)).toBeUndefined();
      expect(
        ordered.decode(
          ordered.encode({ sortOrder: 0, id: "nope", name: "VIP" }),
        ),
      ).toBeUndefined();
    });
  });

  describe("input fragments", () => {
    const parse = (cursor: string) =>
      cursor === "ok" ? { id: cursor } : undefined;
    const schema = z.object({
      query: listSearchInput(100),
      limit: listLimitInput(50, 20),
      cursor: listCursorInput(parse, 80),
    });

    it("defaults limit and rejects oversize search, limit, and bad cursors", () => {
      expect(schema.parse({}).limit).toBe(20);
      expect(schema.safeParse({ limit: 51 }).success).toBe(false);
      expect(schema.safeParse({ limit: 0 }).success).toBe(false);
      expect(schema.safeParse({ query: "   " }).success).toBe(false);
      expect(schema.safeParse({ query: "x".repeat(101) }).success).toBe(false);
      expect(schema.safeParse({ cursor: "nope" }).success).toBe(false);
      expect(schema.parse({ cursor: "ok" }).cursor).toBe("ok");
    });
  });

  describe("LIKE sanitizer", () => {
    it("strips backslash, percent, and underscore; empty remainder is undefined", () => {
      expect(sanitizeLikeLiteral("%%")).toBeUndefined();
      expect(sanitizeLikeLiteral("\\")).toBeUndefined();
      expect(sanitizeLikeLiteral("__")).toBeUndefined();
      expect(sanitizeLikeLiteral("%cake_")).toBe("cake");
      expect(likeContainsPattern("торта")).toBe("%торта%");
      expect(likeContainsPattern("%%")).toBeUndefined();
    });
  });

  describe("nameSearchStems", () => {
    it("stems Ukrainian inflections so every stem AND-matches the nominative name", () => {
      // ≥6 drops last 2: «Самбуки» → «Самбу». The card parenthetical
      // «Самбук» dropped one; both AND-match «Самбука».
      const customerStems = nameSearchStems("Каті Самбуки");
      expect(customerStems).toEqual(["Кат", "Самбу"]);
      expect(nameContainsEveryStem("Катя Самбука", customerStems)).toBe(true);

      const productStems = nameSearchStems("Наполеона");
      expect(productStems).toEqual(["Наполео"]);
      expect(nameContainsEveryStem("Наполеон", productStems)).toBe(true);

      expect(nameSearchStems("торта")).toEqual(["торт"]);
      expect(nameSearchStems("Леха")).toEqual(["Лех"]);
    });

    it("keeps short tokens unchanged", () => {
      expect(nameSearchStems("Ян")).toEqual(["Ян"]);
      expect(nameSearchStems("Ян Лі")).toEqual(["Ян", "Лі"]);
    });

    it("yields a stem that contains-matches mixed-case Latin names", () => {
      const stems = nameSearchStems("aLpHa");
      expect(stems).toHaveLength(1);
      expect(nameContainsEveryStem("Alpha", stems)).toBe(true);
    });

    it("returns no stems after LIKE sanitize empties the query", () => {
      expect(nameSearchStems("%%")).toEqual([]);
      expect(nameSearchStems("\\")).toEqual([]);
      expect(nameSearchStems("__")).toEqual([]);
      expect(nameSearchStems("")).toEqual([]);
      expect(nameSearchStems("   ")).toEqual([]);
    });

    it("collapses whitespace and keeps unique stems in token order", () => {
      expect(nameSearchStems("  Каті   Самбуки  ")).toEqual(["Кат", "Самбу"]);
      expect(nameSearchStems("Каті Каті")).toEqual(["Кат"]);
      expect(nameSearchStems("%Каті% Самбуки_")).toEqual(["Кат", "Самбу"]);
    });
  });

  describe("paginate", () => {
    it("slices limit+1 rows into a page and nextCursor", () => {
      const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const more = paginate(rows, 2, (last) => last.id);
      expect(more.page).toEqual([{ id: "a" }, { id: "b" }]);
      expect(more.nextCursor).toBe("b");

      const exact = paginate(rows.slice(0, 2), 2, (last) => last.id);
      expect(exact.page).toEqual([{ id: "a" }, { id: "b" }]);
      expect(exact.nextCursor).toBeNull();

      const empty = paginate([], 2, (last: { id: string }) => last.id);
      expect(empty).toEqual({ page: [], nextCursor: null });
    });
  });
});
