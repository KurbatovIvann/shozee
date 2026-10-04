import type { AssistantSurfaceDestinationDeclaration } from "./destination.js";
import {
  booleanOrNull,
  isAssistantSurfaceResultOutput,
  isRecord,
  textOrNull,
  unwrapToolOutput,
  wholeCountOrNull,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const PRICE_LIST_ENTITY_GET_TOOL = "pricing_getPriceList";

export const PRICE_LIST_ENTITY_SURFACE_TOOLS = [
  PRICE_LIST_ENTITY_GET_TOOL,
] as const;

const PRICE_LIST_ENTITY_TOOLS = new Set<string>(
  PRICE_LIST_ENTITY_SURFACE_TOOLS,
);

export const PRICE_LIST_ENTITY_ACTION_NAMES = ["pricing.getPriceList"] as const;

export const PRICE_LIST_ENTITY_PROMPT_LINE =
  "After pricing_getPriceList the UI already shows a price list entity card with the name, the default and inactive markers and the entry count. Reply with a short product-language summary. Do not dump tool JSON.";

export const PRICE_LIST_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantPriceListEntityData = {
  readonly kind: "price-list-entity";
  readonly priceListId: string;
  readonly name: string | null;
  readonly isDefault: boolean | null;
  readonly isActive: boolean | null;
  readonly entryCount: number | null;
  readonly toolCallId?: string;
};

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantPriceListEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const priceListId = textOrNull(payload["id"]);
  if (priceListId === null) {
    return null;
  }
  const entity: AssistantPriceListEntityData = {
    kind: "price-list-entity",
    priceListId,
    name: textOrNull(payload["name"]),
    isDefault: booleanOrNull(payload["isDefault"]),
    isActive: booleanOrNull(payload["isActive"]),
    entryCount: wholeCountOrNull(payload["entryCount"]),
  };
  const callId = result.toolCallId;
  if (typeof callId === "string" && callId.length > 0) {
    return { ...entity, toolCallId: callId };
  }
  return entity;
}

export function parsePriceListEntitySurfaces(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantPriceListEntityData[] {
  const entities: AssistantPriceListEntityData[] = [];
  for (const result of results) {
    if (!PRICE_LIST_ENTITY_TOOLS.has(result.toolName)) {
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
