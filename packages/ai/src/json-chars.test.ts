import { describe, expect, it } from "vitest";

import {
  staffAssistantJsonChars,
  staffAssistantPostgresJsonbTextChars,
} from "./json-chars.js";

describe("staffAssistantPostgresJsonbTextChars", () => {
  it("adds a space after structural colons and commas, not inside strings", () => {
    expect(staffAssistantPostgresJsonbTextChars({ a: 1 })).toBe(
      '{"a": 1}'.length,
    );
    expect(staffAssistantPostgresJsonbTextChars({ a: 1, b: 2 })).toBe(
      '{"a": 1, "b": 2}'.length,
    );
    expect(staffAssistantPostgresJsonbTextChars([1, 2])).toBe("[1, 2]".length);
    expect(staffAssistantPostgresJsonbTextChars({ pad: "a:b,c" })).toBe(
      '{"pad": "a:b,c"}'.length,
    );
    expect(staffAssistantJsonChars({ a: 1, b: 2 })).toBe('{"a":1,"b":2}'.length);
    expect(staffAssistantPostgresJsonbTextChars({ a: 1, b: 2 })).toBeGreaterThan(
      staffAssistantJsonChars({ a: 1, b: 2 }),
    );
  });

  it("is one character longer than stringify for { pad: xs } so CHECK can reject a stringify-accepted payload", () => {
    const stringifyLimit = { pad: "x".repeat(21_990) };
    expect(staffAssistantJsonChars(stringifyLimit)).toBe(22_000);
    expect(staffAssistantPostgresJsonbTextChars(stringifyLimit)).toBe(22_001);
    const postgresLimit = { pad: "x".repeat(21_989) };
    expect(staffAssistantPostgresJsonbTextChars(postgresLimit)).toBe(22_000);
  });
});
