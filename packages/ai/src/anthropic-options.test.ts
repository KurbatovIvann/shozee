import { describe, expect, it } from "vitest";

import {
  STAFF_ASSISTANT_CACHE_CONTROL,
  STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_STATIC_CACHE_CONTROL,
} from "./anthropic-options.js";

describe("staff assistant prompt-cache breakpoints", () => {
  it("sets ttl 1h on the static system/tools prefix and 5m on history", () => {
    expect(STAFF_ASSISTANT_STATIC_CACHE_CONTROL).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect(STAFF_ASSISTANT_CACHE_CONTROL).toEqual({
      type: "ephemeral",
      ttl: "5m",
    });
    expect(STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_STATIC_CACHE_CONTROL },
    });
    expect(STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_CACHE_CONTROL },
    });
    expect(
      STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS.anthropic.cacheControl.ttl,
    ).toBe("1h");
    expect(
      STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS.anthropic.cacheControl.ttl,
    ).toBe("5m");
  });
});
