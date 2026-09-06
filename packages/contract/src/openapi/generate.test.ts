import { readFile } from "node:fs/promises";

import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildContractRouter } from "../client/contract-router.js";
import {
  assertOpenApiMatches,
  generateOpenApiDocument,
  renderOpenApiJson,
} from "./generate.js";

const readDefaults = {
  aiExposure: "internal" as const,
  risk: "read" as const,
  requiresConfirmation: false,
  idempotent: false,
  emits: [] as const,
  atomicCalls: [] as const,
  atomicCallers: [] as const,
  errors: [] as const,
  audit: false,
  timeout: 5_000,
};

describe("OpenAPI generation", () => {
  it("committed artifact matches generation", async () => {
    const generated = renderOpenApiJson(await generateOpenApiDocument());
    const committed = await readFile(
      new URL("../../openapi.json", import.meta.url),
      "utf8",
    );
    assertOpenApiMatches(committed, generated);
  });

  it("includes assistant client actions and omits internal persistence actions", async () => {
    const json = JSON.stringify(await generateOpenApiDocument());
    expect(json).toContain("/assistant/createConversation");
    expect(json).toContain("/assistant/listConversations");
    expect(json).toContain("/assistant/getConversation");
    expect(json).toContain("/assistant/appendUserMessage");
    expect(json).not.toContain("recordAssistantTurn");
    expect(json).not.toContain("getStaffActor");
  });

  it("fails when the committed artifact does not match generation", async () => {
    const generated = renderOpenApiJson(await generateOpenApiDocument());
    expect(() => {
      assertOpenApiMatches("{}\n", generated);
    }).toThrow(/OpenAPI drift/);
  });

  it("puts a client action description on the document and omits nothing from an empty composition", async () => {
    const empty = await generateOpenApiDocument();
    const emptyJson = JSON.stringify(empty);
    expect(emptyJson).toContain("Shozee API");
    expect(emptyJson).toContain("/api/v1");

    const listThings = defineActionContract({
      ...readDefaults,
      name: "sample.listThings",
      description: "List sample things for the active company.",
      principal: "staff",
      transport: "client",
      input: z.object({ limit: z.number().int().min(1) }),
      output: z.object({ items: z.array(z.string()) }),
      permissions: ["sample:view"],
    });
    const populated = await generateOpenApiDocument(
      buildContractRouter({ sample: { listThings } }),
    );
    expect(JSON.stringify(populated)).toContain(
      "List sample things for the active company.",
    );
  });

  it("includes share-principal client actions and never a share-token header (ADR-0022)", async () => {
    const getShared = defineActionContract({
      ...readDefaults,
      name: "sample.getShared",
      description: "Anonymous share-token read of one document.",
      principal: "share",
      transport: "client",
      input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
      output: z.object({ companyId: z.string() }),
      permissions: [],
    });
    const submitShare = defineActionContract({
      ...readDefaults,
      name: "sample.submitShare",
      description: "Anonymous share-token write of a dual-signed container.",
      principal: "share",
      transport: "client",
      risk: "write",
      idempotent: true,
      audit: true,
      input: z.object({ token: z.string().min(1), documentId: z.uuid() }),
      output: z.object({ ok: z.boolean() }),
      permissions: [],
    });
    const populated = await generateOpenApiDocument(
      buildContractRouter({ sample: { getShared, submitShare } }),
    );
    const json = JSON.stringify(populated);
    expect(json).toContain("Anonymous share-token read of one document.");
    expect(json).toContain(
      "Anonymous share-token write of a dual-signed container.",
    );
    expect(json).not.toContain("x-share-token");
  });

  it("emits per-operation responses from the action's declared errors", async () => {
    const getThing = defineActionContract({
      ...readDefaults,
      name: "sample.getThing",
      description: "Get one sample thing.",
      principal: "staff",
      transport: "client",
      input: z.object({ id: z.uuid() }),
      output: z.object({ id: z.uuid() }),
      permissions: ["sample:view"],
      errors: ["NOT_FOUND", "CONFLICT"],
    });
    const modules = { sample: { getThing } };
    const populated = await generateOpenApiDocument(
      buildContractRouter(modules),
      modules,
    );
    const json = JSON.stringify(populated);
    expect(json).toContain('"404"');
    expect(json).toContain('"NOT_FOUND"');
    expect(json).toContain('"409"');
    expect(json).toContain('"CONFLICT"');
  });
});
