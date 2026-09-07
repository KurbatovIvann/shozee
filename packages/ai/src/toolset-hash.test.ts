import { describe, expect, it } from "vitest";

import {
  staffAssistantToolsetHash,
  STAFF_ASSISTANT_EMPTY_TOOLSET_HASH,
} from "./toolset-hash.js";

describe("staffAssistantToolsetHash", () => {
  it("returns a fixed sentinel for an empty catalog", () => {
    expect(staffAssistantToolsetHash([])).toBe(
      STAFF_ASSISTANT_EMPTY_TOOLSET_HASH,
    );
  });

  it("is order-independent and changes when the contract set changes", () => {
    const listOnly = staffAssistantToolsetHash(["orders_list"]);
    const reversed = staffAssistantToolsetHash(["orders_get", "orders_list"]);
    const listed = staffAssistantToolsetHash(["orders_list", "orders_get"]);
    expect(listOnly).not.toBe(STAFF_ASSISTANT_EMPTY_TOOLSET_HASH);
    expect(listOnly).toMatch(/^[0-9a-f]{16}$/);
    expect(reversed).toBe(listed);
    expect(reversed).not.toBe(listOnly);
  });

  it("changes when the adapter id changes", () => {
    const names = ["orders_list", "orders_get"] as const;
    const anthropic = staffAssistantToolsetHash(names, "anthropic");
    const fake = staffAssistantToolsetHash(names, "fake");
    expect(anthropic).not.toBe(fake);
    expect(staffAssistantToolsetHash(names)).not.toBe(anthropic);
    expect(staffAssistantToolsetHash([], "anthropic")).toBe(
      STAFF_ASSISTANT_EMPTY_TOOLSET_HASH,
    );
  });
});
