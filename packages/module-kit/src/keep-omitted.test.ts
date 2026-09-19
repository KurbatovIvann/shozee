import { describe, expect, it } from "vitest";

import { keepOmitted } from "./keep-omitted.js";

describe("keepOmitted", () => {
  it("keeps the current value when the field is omitted", () => {
    expect(keepOmitted<string | null>(undefined, "kept")).toBe("kept");
  });

  it("takes an explicit null as a clear", () => {
    expect(keepOmitted<string | null>(null, "kept")).toBeNull();
  });

  it("takes a submitted value over the current one", () => {
    expect(keepOmitted<string | null>("new", "kept")).toBe("new");
  });
});
