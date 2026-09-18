import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  exactNameSql,
  isFuzzyToken,
  nameMatch,
  strictTsQuery,
} from "./name-match.js";

const columns = { name: sql`"t"."name"`, nameFts: sql`"t"."name_fts"` };
const render = (fragment: Parameters<PgDialect["sqlToQuery"]>[0]) =>
  new PgDialect().sqlToQuery(fragment);

describe("strictTsQuery", () => {
  it("asks for a word that starts with the token's stem", () => {
    expect(strictTsQuery("олени")).toBe("олен:*");
    expect(strictTsQuery("оптовиків")).toBe("оптовик:*");
    expect(strictTsQuery("мак")).toBe("мак:*");
  });

  it("matches the parts of an apostrophe or hyphen token as a phrase", () => {
    expect(strictTsQuery("кав'ярні")).toBe("кав <-> яр:*");
    expect(strictTsQuery("нью-йорк")).toBe("нью <-> йо:*");
  });

  it("has no strict form for a token without a letter or a digit", () => {
    expect(strictTsQuery("—")).toBeUndefined();
  });
});

describe("isFuzzyToken", () => {
  it("allows a trigram match from five characters", () => {
    expect(isFuzzyToken("кава")).toBe(false);
    expect(isFuzzyToken("капуч")).toBe(true);
  });
});

describe("nameMatch", () => {
  it("has no predicate for no tokens", () => {
    const match = nameMatch(columns, []);
    expect(match.strict).toBeUndefined();
    expect(match.strictOrFuzzy).toBeUndefined();
  });

  it("keeps short tokens strict and lets long tokens also match by trigram", () => {
    const match = nameMatch(columns, ["кап", "капучіно"]);
    const strict = render(match.strict ?? sql``);
    const either = render(match.strictOrFuzzy ?? sql``);

    expect(strict.sql).not.toContain("<%");
    expect(strict.params).toEqual(["кап:*", "капучі:*"]);
    expect(either.sql.match(/<%/g)).toHaveLength(1);
    expect(either.params).toEqual(["кап:*", "капучі:*", "капучіно"]);
  });

  it("ranks a strict row above any fuzzy-only row", () => {
    const rank = render(nameMatch(columns, ["капучіно"]).rank);
    expect(rank.sql).toContain("CASE WHEN");
    expect(rank.sql).toContain("ts_rank");
    expect(rank.sql).toContain("word_similarity");
    expect(rank.params).toContain(16);
  });
});

describe("exactNameSql", () => {
  it("compares the folded name with the folded query", () => {
    const exact = render(exactNameSql(columns.name, "Кав’ярня"));
    expect(exact.params.at(-1)).toBe("кав'ярня");
  });
});
