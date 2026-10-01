import { CoreInvariantError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import { previewCompanyScope } from "./preview-scope.js";

const contract = { name: "demo.act" };

describe("previewCompanyScope", () => {
  it("returns the verified company scope", () => {
    expect(previewCompanyScope("company-1", contract)).toBe("company-1");
  });

  it("names the contract when a company-scoped preview read has no scope", () => {
    expect(() => previewCompanyScope(null, contract)).toThrow(
      CoreInvariantError,
    );
    expect(() => previewCompanyScope(null, contract)).toThrow("demo.act");
  });
});
