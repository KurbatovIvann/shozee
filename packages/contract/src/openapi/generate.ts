/**
 * OpenAPI document derived from the client contract router (contract.md §5).
 * Generation is the single source; `openapi.json` is the committed artifact
 * the CI drift check diffs against, like migrations.
 *
 * Per-operation error responses come from each action's declared `errors`
 * set (SHO-485). Pipeline-universal codes stay on the global §4 table.
 */
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { AnyContractRouter } from "@orpc/contract";
import {
  type DeclaredErrorCode,
  isDeclaredErrorCode,
} from "@showzy/core/contract";

import type { ContractModuleMap } from "../client/contract-router.js";
import { contractModules, contractRouter } from "../client/modules.js";
import { wireErrorStatus } from "../client/wire-errors.js";

export const OPENAPI_INFO = {
  title: "Shozee API",
  version: "0.0.0",
  description:
    "Generated from the action contract layer. Action descriptions are the OpenAPI summaries (contract.md §5).",
} as const;

/** REST aliases live at `/api/v1` (contract.md §3); fnd-T26 mounts them. */
export const OPENAPI_SERVERS = [{ url: "/api/v1" }] as const;

export async function generateOpenApiDocument(
  router: AnyContractRouter = contractRouter,
  modules: ContractModuleMap = contractModules,
): Promise<unknown> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const document = await generator.generate(router, {
    info: { ...OPENAPI_INFO },
    servers: [...OPENAPI_SERVERS],
  });
  return addDeclaredErrorResponses(document, modules);
}

export function renderOpenApiJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function assertOpenApiMatches(
  committed: string,
  generated: string,
): void {
  if (committed !== generated) {
    throw new Error(
      "OpenAPI drift: committed packages/contract/openapi.json does not match generation. Run `pnpm --filter @showzy/contract openapi:generate`.",
    );
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function addDeclaredErrorResponses(
  document: unknown,
  modules: ContractModuleMap,
): unknown {
  if (!isObjectRecord(document) || !isObjectRecord(document.paths)) {
    return document;
  }
  const paths = document.paths;
  for (const actions of Object.values(modules)) {
    for (const contract of Object.values(actions)) {
      if (contract.errors.length === 0) {
        continue;
      }
      applyDeclaredErrorsToPaths(paths, contract.name, contract.errors);
    }
  }
  return document;
}

function applyDeclaredErrorsToPaths(
  paths: Record<string, unknown>,
  actionName: string,
  codes: readonly DeclaredErrorCode[],
): void {
  for (const item of Object.values(paths)) {
    if (!isObjectRecord(item)) {
      continue;
    }
    for (const method of Object.values(item)) {
      if (!isObjectRecord(method) || method.operationId !== actionName) {
        continue;
      }
      const responses = isObjectRecord(method.responses)
        ? method.responses
        : {};
      const extras: Record<string, unknown> = {};
      for (const code of codes) {
        if (!isDeclaredErrorCode(code)) {
          continue;
        }
        extras[String(wireErrorStatus[code])] = declaredErrorResponse(code);
      }
      method.responses = { ...responses, ...extras };
    }
  }
}

function declaredErrorResponse(
  code: DeclaredErrorCode,
): Record<string, unknown> {
  const status = wireErrorStatus[code];
  const properties: Record<string, unknown> = {
    code: { type: "string", const: code },
    status: { type: "integer", const: status },
    message: { type: "string" },
  };
  const required = ["code", "status", "message"];
  if (code === "VALIDATION") {
    properties.data = {
      type: "object",
      properties: {
        issues: { type: "array", items: { type: "object" } },
      },
      required: ["issues"],
    };
    required.push("data");
  }
  return {
    description: code,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties,
          required,
        },
      },
    },
  };
}
