import { describe, expect, it } from "vitest";

import { staffAssistantTurnContextAddendum } from "./turn-context.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("staffAssistantTurnContextAddendum", () => {
  it("always includes the injected clock and UAH, never a company id", () => {
    const addendum = staffAssistantTurnContextAddendum({ now: NOW });
    expect(addendum).toContain(
      "Turn context (not cached; changes every turn).",
    );
    expect(addendum).toContain("Europe/Kyiv");
    expect(addendum).toContain("Wednesday");
    expect(addendum).toContain("2 September 2026");
    expect(addendum).toContain("week starts on Monday");
    expect(addendum).toContain("period=today");
    expect(addendum).toContain("Money is UAH.");
    expect(addendum).not.toContain("This company is called");
    expect(addendum).not.toContain(COMPANY_ID);
    expect(addendum).not.toContain("ЄДРПОУ");
    expect(addendum).not.toContain("IBAN");
  });

  it("includes the trade name when provided and still omits ids", () => {
    const addendum = staffAssistantTurnContextAddendum({
      now: NOW,
      companyName: "  Качани  ",
    });
    expect(addendum).toContain("This company is called Качани. Money is UAH.");
    expect(addendum).not.toContain(COMPANY_ID);
    expect(addendum).not.toContain("konditerska");
  });

  it("omits the name line when companyName is blank", () => {
    const addendum = staffAssistantTurnContextAddendum({
      now: NOW,
      companyName: "   ",
    });
    expect(addendum).toContain("Money is UAH.");
    expect(addendum).not.toContain("This company is called");
  });
});
