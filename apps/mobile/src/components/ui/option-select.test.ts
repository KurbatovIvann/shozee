import { describe, expect, it } from "vitest";

import {
  filterOptionSelectItems,
  flattenPages,
  optionSelectItems,
  resolveQuerySelectMode,
  visibleOptionSelectItems,
} from "./option-select";

describe("optionSelectItems", () => {
  it("drops blank descriptions", () => {
    expect(
      optionSelectItems([
        { id: "a", name: "Опт", description: "Для гурту" },
        { id: "b", name: "VIP", description: null },
      ]),
    ).toEqual([
      { id: "a", name: "Опт", description: "Для гурту" },
      { id: "b", name: "VIP" },
    ]);
  });
});

describe("filterOptionSelectItems", () => {
  const options = optionSelectItems([
    { id: "a", name: "Марія", description: "+38067" },
    { id: "b", name: "Олег", description: null },
    { id: "c", name: "#12", description: "1 200 ₴" },
  ]);

  it("returns every option when the query is blank", () => {
    expect(filterOptionSelectItems(options, "  ")).toEqual(options);
  });

  it("matches name or description case-insensitively", () => {
    expect(filterOptionSelectItems(options, "мар")).toEqual([options[0]]);
    expect(filterOptionSelectItems(options, "380")).toEqual([options[0]]);
    expect(filterOptionSelectItems(options, "12")).toEqual([options[2]]);
    expect(filterOptionSelectItems(options, "200")).toEqual([options[2]]);
  });
});

describe("visibleOptionSelectItems", () => {
  const options = optionSelectItems([
    { id: "a", name: "Марія", description: "+38067" },
    { id: "b", name: "Олег", description: null },
  ]);

  it("returns the caller's options untouched when server-filtered", () => {
    expect(
      visibleOptionSelectItems({
        options,
        query: "мар",
        serverFiltered: true,
      }),
    ).toBe(options);
  });

  it("filters locally when not server-filtered", () => {
    expect(
      visibleOptionSelectItems({
        options,
        query: "мар",
        serverFiltered: false,
      }),
    ).toEqual([options[0]]);
  });
});

describe("resolveQuerySelectMode", () => {
  it("is uncontrolled when both props are absent", () => {
    expect(
      resolveQuerySelectMode({ query: undefined, onQueryChange: undefined }),
    ).toEqual({ controlled: false });
  });

  it("is uncontrolled when only query is passed", () => {
    expect(
      resolveQuerySelectMode({ query: "мар", onQueryChange: undefined }),
    ).toEqual({ controlled: false });
  });

  it("is uncontrolled when only onQueryChange is passed", () => {
    expect(
      resolveQuerySelectMode({ query: undefined, onQueryChange: () => {} }),
    ).toEqual({ controlled: false });
  });

  it("is controlled only when both props are passed together", () => {
    const onQueryChange = (): void => {};
    expect(resolveQuerySelectMode({ query: "мар", onQueryChange })).toEqual({
      controlled: true,
      query: "мар",
      onQueryChange,
    });
  });
});

describe("flattenPages", () => {
  it("concatenates page items", () => {
    expect(flattenPages([{ items: [1, 2] }, { items: [3] }])).toEqual([
      1, 2, 3,
    ]);
  });
});
