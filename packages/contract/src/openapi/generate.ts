/**
 * OpenAPI document derived from the client contract router (contract.md §5).
 * Generation is the single source; `openapi.json` is the committed artifact
 * the CI drift check diffs against, like migrations.
 *
 * Per-operation error responses are the oRPC document of each procedure's
 * `.errors()` map: pipeline-universal §4 codes union the action's declared
 * `errors` (`VALIDATION`, `NOT_FOUND`, `CONFLICT`). Do not replace
 * status-keyed responses after generation — shared 409 must stay a oneOf.
 */
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { AnyContractRouter } from "@orpc/contract";

import { contractRouter } from "../client/modules.js";

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
): Promise<unknown> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(router, {
    info: { ...OPENAPI_INFO },
    servers: [...OPENAPI_SERVERS],
  });
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
