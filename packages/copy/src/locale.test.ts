import { describe, expect, it } from "vitest";

import { detectLocale, interpolate, selectCopy } from "./locale.js";

describe("detectLocale", () => {
  it("defaults to Ukrainian with no argument and non-en tags", () => {
    expect(detectLocale()).toBe("uk");
    expect(detectLocale("uk-UA")).toBe("uk");
    expect(detectLocale("UK")).toBe("uk");
    expect(detectLocale("de-DE")).toBe("uk");
  });

  it("picks English only from an en* locale tag", () => {
    expect(detectLocale("en")).toBe("en");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("en-GB")).toBe("en");
    expect(detectLocale("EN-us")).toBe("en");
  });
});

describe("interpolate", () => {
  it("replaces own keys and ignores prototype-chain values", () => {
    const vars = Object.create({ inherited: "nope" }) as Record<string, string>;
    vars.own = "yes";
    expect(interpolate("{{inherited}}|{{own}}|{{missing}}", vars)).toBe(
      "|yes|",
    );
  });
});

describe("selectCopy", () => {
  it("selects uk or en from a namespace pair", () => {
    expect(selectCopy("uk", { uk: "Клієнти", en: "Customers" })).toBe(
      "Клієнти",
    );
    expect(selectCopy("en", { uk: "Клієнти", en: "Customers" })).toBe(
      "Customers",
    );
  });
});
