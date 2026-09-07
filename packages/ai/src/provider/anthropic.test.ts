import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { StaffAssistantNotConfiguredError } from "../errors.js";
import {
  createAnthropicStaffProviderAdapter,
  staffAssistantAnthropicRateTier,
  STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK,
  STAFF_ASSISTANT_CACHE_CONTROL,
  STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_STATIC_CACHE_CONTROL,
} from "./anthropic.js";

const ANTHROPIC_SDK = "@ai-sdk/anthropic";

function walkTsFiles(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, files);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
}

describe("packages/ai/src Anthropic import boundary (SHO-508)", () => {
  it(`confines ${ANTHROPIC_SDK} to provider/anthropic.ts and this test`, () => {
    const srcRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const files: string[] = [];
    walkTsFiles(srcRoot, files);
    expect(files.length).toBeGreaterThan(0);
    const hits = files
      .filter((file) => readFileSync(file, "utf8").includes(ANTHROPIC_SDK))
      .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"));
    expect(hits.toSorted()).toEqual([
      "provider/anthropic.test.ts",
      "provider/anthropic.ts",
    ]);
  });
});

describe("staff assistant prompt-cache breakpoints", () => {
  it("sets ttl 1h on the static system/tools prefix and 5m on history", () => {
    const provider = createAnthropicStaffProviderAdapter();
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
    expect(provider.systemProviderOptions()).toEqual(
      STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
    );
    expect(provider.historyBreakpointOptions()).toEqual(
      STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS,
    );
    expect(
      STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS.anthropic.cacheControl.ttl,
    ).toBe("1h");
    expect(
      STAFF_ASSISTANT_HISTORY_CACHE_PROVIDER_OPTIONS.anthropic.cacheControl.ttl,
    ).toBe("5m");
  });
});

describe("Anthropic adapter pricing", () => {
  it("prices known families and returns null for unknown models", () => {
    const provider = createAnthropicStaffProviderAdapter();
    expect(staffAssistantAnthropicRateTier("claude-sonnet-4-6")).toBe("sonnet");
    expect(staffAssistantAnthropicRateTier("claude-haiku-4-5")).toBe("haiku");
    expect(staffAssistantAnthropicRateTier("claude-opus-4-6")).toBe("opus");
    expect(staffAssistantAnthropicRateTier("some-unknown-model")).toBeNull();
    expect(provider.pricing("claude-opus-4-6")).toEqual(
      STAFF_ASSISTANT_ANTHROPIC_RATES_USD_PER_MTOK.opus,
    );
    expect(provider.pricing("some-unknown-model")).toBeNull();
  });
});

describe("createAnthropicStaffProviderAdapter", () => {
  it("does not construct a model without an API key", () => {
    const provider = createAnthropicStaffProviderAdapter();
    expect(() => provider.createModel("reply")).toThrow(
      StaffAssistantNotConfiguredError,
    );
  });

  it("constructs a model without touching the network when a key is present", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const provider = createAnthropicStaffProviderAdapter({
      apiKey: "sk-ant-test-not-a-real-key",
      replyModel: "claude-sonnet-4-6",
      gateModel: "claude-haiku-4-5",
    });
    expect(provider.createModel("reply")).toBeDefined();
    expect(provider.createModel("gate")).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
