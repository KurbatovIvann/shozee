import type { AssistantSurfaceDestinationDeclaration } from "./destination.js";
import {
  isAssistantSurfaceResultOutput,
  isRecord,
  textOrNull,
  unwrapToolOutput,
  wholeCountOrNull,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const CUSTOMER_GROUP_ENTITY_GET_TOOL = "customers_getGroup";

export const CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS = [
  CUSTOMER_GROUP_ENTITY_GET_TOOL,
] as const;

const CUSTOMER_GROUP_ENTITY_TOOLS = new Set<string>(
  CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS,
);

export const CUSTOMER_GROUP_ENTITY_ACTION_NAMES = [
  "customers.getGroup",
] as const;

export const CUSTOMER_GROUP_ENTITY_PROMPT_LINE =
  "After customers.getGroup the UI already shows a customer group entity card with the name, the description and the client count. Reply with a short product-language summary. Do not dump tool JSON.";

export const CUSTOMER_GROUP_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantCustomerGroupEntityData = {
  readonly kind: "customer-group-entity";
  readonly groupId: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly memberCount: number | null;
  readonly toolCallId?: string;
};

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantCustomerGroupEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const groupId = textOrNull(payload["id"]);
  if (groupId === null) {
    return null;
  }
  const entity: AssistantCustomerGroupEntityData = {
    kind: "customer-group-entity",
    groupId,
    name: textOrNull(payload["name"]),
    description: textOrNull(payload["description"]),
    memberCount: wholeCountOrNull(payload["memberCount"]),
  };
  const callId = result.toolCallId;
  if (typeof callId === "string" && callId.length > 0) {
    return { ...entity, toolCallId: callId };
  }
  return entity;
}

export function parseCustomerGroupEntitySurfaces(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantCustomerGroupEntityData[] {
  const entities: AssistantCustomerGroupEntityData[] = [];
  for (const result of results) {
    if (!CUSTOMER_GROUP_ENTITY_TOOLS.has(result.toolName)) {
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
