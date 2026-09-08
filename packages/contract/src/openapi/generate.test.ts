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

const pipeline409Codes = [
  "CONFIRMATION_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "RETRY_IN_PROGRESS",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findOperation(
  document: unknown,
  operationId: string,
): Record<string, unknown> {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("OpenAPI document has no paths");
  }
  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const method of Object.values(pathItem)) {
      if (isRecord(method) && method.operationId === operationId) {
        return method;
      }
    }
  }
  throw new Error(`OpenAPI document has no operation "${operationId}"`);
}

function schemaVariants(schema: unknown): unknown[] {
  if (!isRecord(schema)) {
    return [];
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf;
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf;
  }
  return [schema];
}

function definedErrorCodesForStatus(
  operation: Record<string, unknown>,
  status: string,
): string[] {
  if (!isRecord(operation.responses)) {
    return [];
  }
  const response = operation.responses[status];
  if (!isRecord(response) || !isRecord(response.content)) {
    return [];
  }
  const json = response.content["application/json"];
  if (!isRecord(json)) {
    return [];
  }
  const codes: string[] = [];
  for (const variant of schemaVariants(json.schema)) {
    if (!isRecord(variant) || !isRecord(variant.properties)) {
      continue;
    }
    const defined = variant.properties.defined;
    const code = variant.properties.code;
    if (!isRecord(defined) || defined.const !== true) {
      continue;
    }
    if (isRecord(code) && typeof code.const === "string") {
      codes.push(code.const);
    }
  }
  return codes;
}

function responseJsonSchema(
  operation: Record<string, unknown>,
  status: string,
): unknown {
  if (!isRecord(operation.responses)) {
    return undefined;
  }
  const response = operation.responses[status];
  if (!isRecord(response) || !isRecord(response.content)) {
    return undefined;
  }
  const json = response.content["application/json"];
  return isRecord(json) ? json.schema : undefined;
}

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
    expect(json).not.toContain("getModelHistory");
    expect(json).not.toContain("checkpointAssistantTurn");
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

  it("empty declared errors do not document domain CONFLICT as the sole 409", async () => {
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
    const operation = findOperation(populated, "sample.listThings");
    const codes409 = definedErrorCodesForStatus(operation, "409");
    expect(codes409).toEqual(expect.arrayContaining([...pipeline409Codes]));
    expect(codes409).not.toContain("CONFLICT");
  });

  it("declared NOT_FOUND does not collapse 409 to CONFLICT", async () => {
    const getThing = defineActionContract({
      ...readDefaults,
      name: "sample.getThing",
      description: "Get one sample thing.",
      principal: "staff",
      transport: "client",
      input: z.object({ id: z.uuid() }),
      output: z.object({ id: z.uuid() }),
      permissions: ["sample:view"],
      errors: ["NOT_FOUND"],
    });
    const populated = await generateOpenApiDocument(
      buildContractRouter({ sample: { getThing } }),
    );
    const operation = findOperation(populated, "sample.getThing");
    expect(definedErrorCodesForStatus(operation, "404")).toContain("NOT_FOUND");
    const codes409 = definedErrorCodesForStatus(operation, "409");
    expect(codes409).toEqual(expect.arrayContaining([...pipeline409Codes]));
    expect(codes409).not.toContain("CONFLICT");
  });

  it("declared CONFLICT on an idempotent writer keeps pipeline 409 codes", async () => {
    const createThing = defineActionContract({
      ...readDefaults,
      name: "sample.createThing",
      description: "Create one sample thing.",
      principal: "staff",
      transport: "client",
      risk: "write",
      idempotent: true,
      audit: true,
      input: z.object({ name: z.string().min(1) }),
      output: z.object({ id: z.uuid() }),
      permissions: ["sample:manage"],
      errors: ["CONFLICT"],
    });
    const populated = await generateOpenApiDocument(
      buildContractRouter({ sample: { createThing } }),
    );
    const operation = findOperation(populated, "sample.createThing");
    const codes409 = definedErrorCodesForStatus(operation, "409");
    expect(codes409).toEqual(
      expect.arrayContaining(["CONFLICT", ...pipeline409Codes]),
    );
  });

  it("declared VALIDATION keeps Zod issue path/message on 400", async () => {
    const listThings = defineActionContract({
      ...readDefaults,
      name: "sample.listThings",
      description: "List sample things for the active company.",
      principal: "staff",
      transport: "client",
      input: z.object({ limit: z.number().int().min(1) }),
      output: z.object({ items: z.array(z.string()) }),
      permissions: ["sample:view"],
      errors: ["VALIDATION"],
    });
    const populated = await generateOpenApiDocument(
      buildContractRouter({ sample: { listThings } }),
    );
    const operation = findOperation(populated, "sample.listThings");
    expect(definedErrorCodesForStatus(operation, "400")).toContain(
      "VALIDATION",
    );
    const schemaJson = JSON.stringify(responseJsonSchema(operation, "400"));
    expect(schemaJson).toContain('"path"');
    expect(schemaJson).toContain('"message"');
    expect(schemaJson).not.toContain('"items":{"type":"object"}');
  });

  it("production confirmation and get operations keep pipeline 409 codes", async () => {
    const document = await generateOpenApiDocument();
    const requestSign = findOperation(document, "documents.requestSign");
    const requestSign409 = definedErrorCodesForStatus(requestSign, "409");
    expect(requestSign409).toEqual(
      expect.arrayContaining([
        "CONFLICT",
        "CONFIRMATION_REQUIRED",
        "IDEMPOTENCY_CONFLICT",
      ]),
    );

    const getOrder = findOperation(document, "orders.get");
    expect(definedErrorCodesForStatus(getOrder, "404")).toContain("NOT_FOUND");
    const getOrder409 = definedErrorCodesForStatus(getOrder, "409");
    expect(getOrder409).toEqual(expect.arrayContaining([...pipeline409Codes]));
    expect(getOrder409).not.toContain("CONFLICT");
  });
});
