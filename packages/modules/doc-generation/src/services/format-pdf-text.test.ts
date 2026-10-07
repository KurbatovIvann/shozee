import { describe, expect, it } from "vitest";

import { CoreInvariantError } from "@showzy/core/errors";

import { formatIssuedOn } from "./format-pdf-text.js";

describe("formatIssuedOn", () => {
  it("splits the stored Kyiv calendar day without Date constructors", () => {
    expect(formatIssuedOn("2026-03-15")).toBe("15.03.2026");
    expect(formatIssuedOn("2025-12-31")).toBe("31.12.2025");
    expect(() => formatIssuedOn("15.03.2026")).toThrow(CoreInvariantError);
  });
});
