import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isAssistantSurfaceResultOutput,
  isRecord,
  moneyMinorFromFields,
  textOrNull,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const PRODUCT_ENTITY_SURFACE_TOOLS = [
  "catalog.getProduct",
  "catalog_getProduct",
  "catalog_get_product",
] as const;

const PRODUCT_ENTITY_TOOLS = new Set<string>(PRODUCT_ENTITY_SURFACE_TOOLS);

export const PRODUCT_ENTITY_ACTION_NAMES = ["catalog.getProduct"] as const;

export const PRODUCT_ENTITY_PROMPT_LINE =
  "After catalog_get_product the UI already shows a product entity card with the name, base price, variant count and archived state. Reply with a short product-language summary. Do not dump tool JSON and do not list the variants one by one.";

export const PRODUCT_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantProductEntityData = {
  readonly kind: "product-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly productId: string;
  readonly name: string | null;
  readonly status: string | null;
  readonly basePrice: AssistantMoneyMinor | null;
  readonly variantCount: number;
  readonly toolCallId?: string;
};

function variantCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantProductEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const productId = textOrNull(payload["id"]);
  if (productId === null) {
    return null;
  }
  const entity: AssistantProductEntityData = {
    kind: "product-entity",
    destination: resolveAssistantSurfaceDestination(
      PRODUCT_ENTITY_DESTINATION,
      `/products/${productId}`,
    ),
    productId,
    name: textOrNull(payload["name"]),
    status: textOrNull(payload["status"]),
    basePrice: moneyMinorFromFields(
      payload["basePriceMinor"],
      payload["currency"],
    ),
    variantCount: variantCount(payload["variants"]),
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
    if (!PRODUCT_ENTITY_TOOLS.has(result.toolName)) {
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
