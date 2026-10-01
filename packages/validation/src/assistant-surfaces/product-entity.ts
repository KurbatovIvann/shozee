import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isAssistantSurfaceResultOutput,
  isRecord,
  moneyMinorFromFields,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const CATALOG_GET_PRODUCT_TOOLS = new Set([
  "catalog.getProduct",
  "catalog_getProduct",
  "catalog_get_product",
]);

export const PRODUCT_ENTITY_SURFACE_TOOLS = [
  "catalog.getProduct",
  "catalog_getProduct",
  "catalog_get_product",
] as const;

export const PRODUCT_ENTITY_ACTION_NAMES = ["catalog.getProduct"] as const;

export const PRODUCT_ENTITY_PROMPT_LINE =
  "After catalog_get_product the UI already shows a product entity card. Reply with a short product-language summary. Do not dump tool JSON.";

export const PRODUCT_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantProductEntityData = {
  readonly kind: "product-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly productId: string;
  readonly name: string;
  readonly status: string | null;
  readonly basePrice: AssistantMoneyMinor | null;
  readonly variantCount: number;
  readonly toolCallId?: string;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantProductEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const productId = payload["id"];
  if (typeof productId !== "string" || productId.length === 0) {
    return null;
  }
  const name = payload["name"];
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const variants = payload["variants"];
  const entity: AssistantProductEntityData = {
    kind: "product-entity",
    destination: resolveAssistantSurfaceDestination(
      PRODUCT_ENTITY_DESTINATION,
      `/products/${productId}`,
    ),
    productId,
    name,
    status: textOrNull(payload["status"]),
    basePrice: moneyMinorFromFields(
      payload["basePriceMinor"],
      payload["currency"],
    ),
    variantCount: Array.isArray(variants) ? variants.length : 0,
  };
  const callId = result.toolCallId;
  if (typeof callId === "string" && callId.length > 0) {
    return { ...entity, toolCallId: callId };
  }
  return entity;
}

export function parseProductEntitySurfaces(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantProductEntityData[] {
  const entities: AssistantProductEntityData[] = [];
  for (const result of results) {
    if (!CATALOG_GET_PRODUCT_TOOLS.has(result.toolName)) {
      continue;
    }
    if (!isAssistantSurfaceResultOutput(result.output)) {
      continue;
    }
    const entity = parseEntity(result);
    if (entity !== null) {
      entities.push(entity);
    }
  }
  return entities;
}
