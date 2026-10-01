import { CoreInvariantError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import { previewCompanyScope } from "./preview-scope.js";

describe("previewCompanyScope", () => {
  it("returns the verified company scope", () => {
    expect(previewCompanyScope("company-1", "demo.act")).toBe("company-1");
  });

  it("refuses a company-scoped preview read without a scope", () => {
    expect(() => previewCompanyScope(null, "demo.act")).toThrow(
      CoreInvariantError,
    );
  });
});
