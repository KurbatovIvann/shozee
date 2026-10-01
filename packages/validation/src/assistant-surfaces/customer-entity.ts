import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isAssistantSurfaceResultOutput,
  isRecord,
  unwrapToolOutput,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const CUSTOMERS_GET_CUSTOMER_TOOLS = new Set([
  "customers.getCustomer",
  "customers_getCustomer",
  "customers_get_customer",
]);

export const CUSTOMER_ENTITY_SURFACE_TOOLS = [
  "customers.getCustomer",
  "customers_getCustomer",
  "customers_get_customer",
] as const;

export const CUSTOMER_ENTITY_ACTION_NAMES = ["customers.getCustomer"] as const;

export const CUSTOMER_ENTITY_PROMPT_LINE =
  "After customers_get_customer the UI already shows a customer entity card. Reply with a short product-language summary. Do not dump tool JSON.";

export const CUSTOMER_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantCustomerEntityData = {
  readonly kind: "customer-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly customerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string | null;
  readonly toolCallId?: string;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantCustomerEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const customerId = payload["id"];
  if (typeof customerId !== "string" || customerId.length === 0) {
    return null;
  }
  const name = payload["name"];
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const entity: AssistantCustomerEntityData = {
    kind: "customer-entity",
    destination: resolveAssistantSurfaceDestination(
      CUSTOMER_ENTITY_DESTINATION,
      `/customers/clients/${customerId}/edit`,
    ),
    customerId,
    name,
    phone: textOrNull(payload["phone"]),
    email: textOrNull(payload["email"]),
    status: textOrNull(payload["status"]),
  };
  const callId = result.toolCallId;
  if (typeof callId === "string" && callId.length > 0) {
    return { ...entity, toolCallId: callId };
  }
  return entity;
}

export function parseCustomerEntitySurfaces(
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantCustomerEntityData[] {
  const entities: AssistantCustomerEntityData[] = [];
  for (const result of results) {
    if (!CUSTOMERS_GET_CUSTOMER_TOOLS.has(result.toolName)) {
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
