import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  classifyStaffAssistantTurn,
  STAFF_ASSISTANT_GATE_SYSTEM,
  staffAssistantGateOutputSchema,
  staffAssistantGateToolPolicy,
} from "./gate.js";
import { STAFF_ASSISTANT_PRODUCT_GLOSSARY } from "./product-glossary.js";
import {
  MockLanguageModelV3,
  mockGenerateObjectResult,
  mockStaffAssistantGateGenerate,
} from "./test.js";
import { EMPTY_STAFF_ASSISTANT_TURN_USAGE } from "./usage.js";

const mockGateUsage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("STAFF_ASSISTANT_GATE_SYSTEM", () => {
  it("shares the product glossary and names modes without job intents", () => {
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain(
      STAFF_ASSISTANT_PRODUCT_GLOSSARY,
    );
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("show last 3 orders");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("how many orders today");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("create an order for");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("hello");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("chitchat");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain(
      "can you help with price lists?",
    );
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain("capability");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain(
      "Чи можеш ти створювати прайс-листи?",
    );
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain(
      "А з чим ти можеш допомогти ще?",
    );
    expect(STAFF_ASSISTANT_GATE_SYSTEM).toContain(
      "If you are unsure, mode job, confidence low",
    );
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain("orders_page");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain("orders_counts");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain("orders_create");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain('"intent"');
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain("intent other");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain("operational true");
    expect(STAFF_ASSISTANT_GATE_SYSTEM).not.toContain(
      "what you can do, or anything off-topic",
    );
  });
});

describe("staffAssistantGateOutputSchema", () => {
  it("parses classifier examples for job, chitchat, and capability", () => {
    expect(
      staffAssistantGateOutputSchema.parse({
        mode: "job",
        confidence: "high",
      }),
    ).toEqual({
      mode: "job",
      confidence: "high",
    });
    expect(
      staffAssistantGateOutputSchema.parse({
        mode: "chitchat",
        confidence: "high",
      }),
    ).toEqual({ mode: "chitchat", confidence: "high" });
    expect(
      staffAssistantGateOutputSchema.parse({
        mode: "capability",
        confidence: "high",
      }).mode,
    ).toBe("capability");
  });

  it("accepts a job without a retired intent field", () => {
    expect(
      staffAssistantGateOutputSchema.safeParse({
        mode: "job",
        confidence: "high",
      }).success,
    ).toBe(true);
  });
});

describe("staffAssistantGateToolPolicy", () => {
  it("attaches the full set for high-confidence job and capability", () => {
    expect(
      staffAssistantGateToolPolicy({
        mode: "job",
        confidence: "high",
      }),
    ).toEqual({ kind: "all" });
    expect(
      staffAssistantGateToolPolicy({
        mode: "capability",
        confidence: "high",
      }),
    ).toEqual({ kind: "all" });
  });

  it("fail-opens to all tools for low confidence, including chitchat", () => {
    expect(
      staffAssistantGateToolPolicy({
        mode: "job",
        confidence: "low",
      }),
    ).toEqual({ kind: "all" });
    expect(
      staffAssistantGateToolPolicy({
        mode: "chitchat",
        confidence: "low",
      }),
    ).toEqual({ kind: "all" });
    expect(
      staffAssistantGateToolPolicy({
        mode: "capability",
        confidence: "low",
      }),
    ).toEqual({ kind: "all" });
  });

  it("attaches no tools for high-confidence chitchat", () => {
    expect(
      staffAssistantGateToolPolicy({
        mode: "chitchat",
        confidence: "high",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("classifyStaffAssistantTurn", () => {
  it("returns chitchat without calling tools", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const model = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "chitchat",
        confidence: "high",
      }),
    });
    await expect(
      classifyStaffAssistantTurn({
        model,
        lastUserText: "hello",
      }),
    ).resolves.toEqual({
      mode: "chitchat",
      confidence: "high",
      usage: mockGateUsage,
    });
    expect(model.doGenerateCalls.length).toBe(1);
    expect(model.doGenerateCalls[0]?.tools).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns high-confidence job for operational examples", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "job",
        confidence: "high",
      }),
    });
    await expect(
      classifyStaffAssistantTurn({
        model,
        lastUserText: "show last 3 orders",
      }),
    ).resolves.toEqual({
      mode: "job",
      confidence: "high",
      usage: mockGateUsage,
    });
  });

  it("returns capability for a price-list help question", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "capability",
        confidence: "high",
      }),
    });
    await expect(
      classifyStaffAssistantTurn({
        model,
        lastUserText: "can you help with price lists?",
      }),
    ).resolves.toEqual({
      mode: "capability",
      confidence: "high",
      usage: mockGateUsage,
    });
  });

  it("skips the model and fail-opens on empty last user text", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: mockStaffAssistantGateGenerate({
        mode: "chitchat",
        confidence: "high",
      }),
    });
    await expect(
      classifyStaffAssistantTurn({ model, lastUserText: "   " }),
    ).resolves.toEqual({
      mode: "job",
      confidence: "low",
      usage: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("fail-opens when classify throws or returns invalid JSON", async () => {
    const throwing = new MockLanguageModelV3({
      doGenerate: () => Promise.reject(new Error("gate down")),
    });
    await expect(
      classifyStaffAssistantTurn({
        model: throwing,
        lastUserText: "List orders",
      }),
    ).resolves.toEqual({
      mode: "job",
      confidence: "low",
      usage: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    });

    const invalid = new MockLanguageModelV3({
      doGenerate: mockGenerateObjectResult("not-json"),
    });
    await expect(
      classifyStaffAssistantTurn({
        model: invalid,
        lastUserText: "List orders",
      }),
    ).resolves.toEqual({
      mode: "job",
      confidence: "low",
      usage: EMPTY_STAFF_ASSISTANT_TURN_USAGE,
    });
  });
});

describe("packages/ai/src production sources", () => {
  it("never mentions toolChoice outside tests that assert absence", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, path.relative(root, file)).not.toMatch(/toolChoice/);
    }
  });
});
