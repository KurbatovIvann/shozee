import { describe, expect, it } from "vitest";

import {
  ENTITY_LOOKUP_OPTIONS_MAX,
  EntityLookupAmbiguousError,
  EntityLookupUnmatchedError,
  classifyEntityLookupMatch,
  entityLookupPicker,
  entityLookupRefusal,
} from "./entity-lookup.js";

type Row = { readonly id: string; readonly name: string };

const fieldsOf = (row: Row): readonly string[] => [row.name];
const nameOf = (row: Row): string => row.name;

function classify(query: string, rows: readonly Row[]) {
  return classifyEntityLookupMatch(query, rows, fieldsOf, nameOf);
}

describe("classifyEntityLookupMatch", () => {
  it("returns the single exact match", () => {
    const rows = [
      { id: "1", name: "Наполеон" },
      { id: "2", name: "Наполеон великий" },
    ];
    expect(classify("наполеон", rows)).toEqual({
      kind: "unique",
      row: rows[0],
    });
  });

  it("returns a unique match in another Ukrainian case", () => {
    const rows = [{ id: "1", name: "Катя Самбука" }];
    expect(classify("Каті Самбуки", rows)).toEqual({
      kind: "unique",
      row: rows[0],
    });
  });

  it("reports several when more than one row matches exactly", () => {
    const rows = [
      { id: "1", name: "Наполеон" },
      { id: "2", name: "наполеон" },
    ];
    expect(classify("наполеон", rows)).toEqual({ kind: "several", rows });
  });

  it("reports the candidates as nearest when none matches exactly", () => {
    const rows = [
      { id: "1", name: "Наполеон великий" },
      { id: "2", name: "Наполеон малий" },
    ];
    expect(classify("наполе", rows)).toEqual({ kind: "nearest", rows });
  });

  it("reports none when nothing was found", () => {
    expect(classify("наполеон", [])).toEqual({ kind: "none" });
  });
});

describe("entityLookupPicker", () => {
  it("sorts by label then id and caps the options", () => {
    const many = Array.from(
      { length: ENTITY_LOOKUP_OPTIONS_MAX + 1 },
      (_, i) => ({
        id: `id-${String(i).padStart(2, "0")}`,
        label: `label-${String(i).padStart(2, "0")}`,
      }),
    );
    const picker = entityLookupPicker([...many].toReversed());
    expect(picker.options).toHaveLength(ENTITY_LOOKUP_OPTIONS_MAX);
    expect(picker.options[0]?.label).toBe("label-00");
    expect(picker.optionsTruncated).toBe(true);
  });

  it("does not report truncation below the cap", () => {
    expect(entityLookupPicker([{ id: "1", label: "a" }])).toEqual({
      options: [{ id: "1", label: "a" }],
      optionsTruncated: false,
    });
  });
});

describe("entityLookupRefusal", () => {
  const target = { kind: "customer", query: "Катя" } as const;

  it("is a conflict carrying the matching options when several matched", () => {
    const error = entityLookupRefusal(target, "several", [
      { id: "1", label: "Катя А" },
      { id: "2", label: "Катя Б" },
    ]);
    expect(error).toBeInstanceOf(EntityLookupAmbiguousError);
    expect(error.code).toBe("CONFLICT");
    expect(error.reason).toBe("ambiguous");
    expect(error.target).toEqual(target);
    expect(error.options).toHaveLength(2);
    expect(error.clientMessage).toBe('Select a customer matching "Катя".');
  });

  it("is a not-found carrying the nearest options when none matched", () => {
    const error = entityLookupRefusal(target, "nearest", [
      { id: "1", label: "Катерина" },
    ]);
    expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.reason).toBe("unmatched_query");
    expect(error.options).toEqual([{ id: "1", label: "Катерина" }]);
    expect(error.clientMessage).toBe('Nothing matches "Катя".');
  });

  it("is a not-found with no options when nothing was near", () => {
    const error = entityLookupRefusal(target, "none", []);
    expect(error).toBeInstanceOf(EntityLookupUnmatchedError);
    expect(error.options).toEqual([]);
    expect(error.optionsTruncated).toBe(false);
  });
});
