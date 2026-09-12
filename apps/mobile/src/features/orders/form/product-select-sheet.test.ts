import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("./product-select-sheet.tsx", import.meta.url),
  "utf8",
);

describe("controlled query", () => {
  it("derives the query mode once from resolveQuerySelectMode", () => {
    expect(SOURCE).toContain("readonly query?: string | undefined;");
    expect(SOURCE).toContain(
      "readonly onQueryChange?: ((value: string) => void) | undefined;",
    );
    expect(SOURCE).toContain("resolveQuerySelectMode({");
    expect(SOURCE).toContain("const serverFiltered = queryMode.controlled;");
    expect(SOURCE).toContain("queryMode.onQueryChange(text);");
    expect(SOURCE).toContain("onChangeText={handleQueryChange}");
  });

  it("derives what the list shows from resolveProductSelectListState", () => {
    expect(SOURCE).toContain("resolveProductSelectListState({");
    expect(SOURCE).not.toContain("filterProductSelectRows(");
  });

  it("only resets local query when the session ends and it is uncontrolled", () => {
    expect(SOURCE).toContain("if (!props.sessionOpen && !serverFiltered) {");
  });
});

describe("paged-result affordances", () => {
  it("shows a loading indicator and a load-more affordance", () => {
    expect(SOURCE).toContain("readonly loadingMore?: boolean | undefined;");
    expect(SOURCE).toContain(
      "readonly onEndReached?: (() => void) | undefined;",
    );
    expect(SOURCE).toContain("<ActivityIndicator");
    expect(SOURCE).toContain("onPress={props.onEndReached}");
  });
});
