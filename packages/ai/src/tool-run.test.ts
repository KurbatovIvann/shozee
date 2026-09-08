import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractUuidResultIds, STAFF_ASSISTANT_MAX_STEPS } from "./tool-run.js";

describe("extractUuidResultIds", () => {
  it("collects top-level uuid ids and ignores nested list rows", () => {
    const orderId = "33333333-3333-4333-8333-333333333333";
    const nestedOrderId = "44444444-4444-4444-8444-444444444444";
    expect(extractUuidResultIds({ orderId, status: "new" })).toEqual([orderId]);
    expect(
      extractUuidResultIds({
        items: [{ orderId }],
        nextCursor: null,
      }),
    ).toEqual([]);
    expect(
      extractUuidResultIds({
        kind: "page.summary",
        items: [{ orderId: nestedOrderId }, { orderId }],
        nextCursor: null,
      }),
    ).toEqual([]);
    expect(
      extractUuidResultIds({
        orderId,
        items: [{ orderId: nestedOrderId }],
      }),
    ).toEqual([orderId]);
    const source = readFileSync(
      new URL("./tool-run.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export function extractUuidResultIds");
    const fn = source.slice(start);
    expect(fn).toContain("RESULT_ID_KEYS");
    expect(fn).not.toContain("items");
    expect(fn).not.toContain("orderId]");
  });
});

describe("STAFF_ASSISTANT_MAX_STEPS", () => {
  it("caps looping tool steps without an extra structured-output step", () => {
    expect(STAFF_ASSISTANT_MAX_STEPS).toBe(9);
  });
});
