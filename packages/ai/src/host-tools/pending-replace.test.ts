import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";

import { PENDING_REPLACE_TOOL_NAME } from "../pending.js";
import {
  createPendingReplaceTool,
  mapPendingReplaceFacadeInput,
  pendingReplaceFacadeSchema,
  pendingReplaceSchemaMentionsHostSecrets,
  PENDING_REPLACE_DESCRIPTION,
} from "./pending-replace.js";

const here = dirname(fileURLToPath(import.meta.url));
const customerId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";

describe("pending_replace host tool", () => {
  it("is a packages/ai host tool, not implementAction and not a mapped façade", () => {
    const src = readFileSync(join(here, "pending-replace.ts"), "utf8");
    expect(src).toContain("createPendingReplaceTool");
    expect(src).not.toMatch(/implementAction\s*\(/);
    expect(src).not.toMatch(/defineActionContract\s*\(/);
    expect(PENDING_REPLACE_TOOL_NAME).toBe("pending_replace");
    expect(PENDING_REPLACE_DESCRIPTION).toContain("Do not send pending id");
  });

  it("schema is façade args only — no pendingId, version, challengeId, or optionId", () => {
    const tool = createPendingReplaceTool({
      actionName: "orders.create",
      apply: () => Promise.resolve({ status: "replaced" }),
    });
    const json = JSON.stringify(asSchema(tool.inputSchema).jsonSchema);
    expect(pendingReplaceSchemaMentionsHostSecrets(json)).toBe(false);
    expect(json).toContain("customerId");
    expect(json).not.toContain("pendingId");
    expect(json).not.toContain("expectedVersion");
    expect(json).not.toContain("challengeId");
    expect(json).not.toContain("optionId");
  });

  it("maps orders.create façade args to canonical input and calls host apply", async () => {
    const apply = vi.fn(() => Promise.resolve({ status: "replaced" as const }));
    const tool = createPendingReplaceTool({
      actionName: "orders.create",
      apply,
    });
    const execute = tool.execute;
    expect(execute).toBeDefined();
    if (execute === undefined) {
      return;
    }
    const facade = {
      customerId,
      items: [{ productId, quantityMilli: "2000" }],
    };
    await execute(facade, {
      toolCallId: "call-replace",
      messages: [],
      context: undefined,
    });
    expect(apply).toHaveBeenCalledWith(facade);
    expect(mapPendingReplaceFacadeInput("orders.create", facade)).toEqual({
      customer: { by: "id", id: customerId },
      items: [
        {
          product: { by: "id", id: productId },
          quantity: { milli: "2000" },
          variantSelection: { kind: "unspecified" },
        },
      ],
    });
  });

  it("refuses an unknown actionName with no named façade schema", () => {
    expect(() => pendingReplaceFacadeSchema("catalog.archiveProduct")).toThrow(
      /no façade schema/,
    );
    expect(() =>
      mapPendingReplaceFacadeInput("catalog.archiveProduct", { id: customerId }),
    ).toThrow(/no façade schema/);
    const src = readFileSync(join(here, "pending-replace.ts"), "utf8");
    expect(src).not.toContain("looseObject");
  });
});
