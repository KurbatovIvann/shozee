import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "./destination.js";
import {
  isAssistantSurfaceResultOutput,
  isRecord,
  textOrNull,
  unwrapToolOutput,
  type AssistantSurfaceToolResult,
} from "./helpers.js";

export const CUSTOMER_ENTITY_SURFACE_TOOLS = [
  "customers.getCustomer",
  "customers_getCustomer",
  "customers_get_customer",
] as const;

const CUSTOMER_ENTITY_TOOLS = new Set<string>(CUSTOMER_ENTITY_SURFACE_TOOLS);

export const CUSTOMER_ENTITY_ACTION_NAMES = ["customers.getCustomer"] as const;

export const CUSTOMER_ENTITY_PROMPT_LINE =
  "After customers_get_customer the UI already shows a customer entity card with the name, contacts and archived state. Reply with a short product-language summary. Do not dump tool JSON and do not repeat the contacts line by line.";

export const CUSTOMER_ENTITY_DESTINATION = {
  kind: "screen",
} as const satisfies AssistantSurfaceDestinationDeclaration;

export type AssistantCustomerEntityData = {
  readonly kind: "customer-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly customerId: string;
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string | null;
  readonly toolCallId?: string;
};

function parseEntity(
  result: AssistantSurfaceToolResult,
): AssistantCustomerEntityData | null {
  const { payload } = unwrapToolOutput(result.output);
  if (!isRecord(payload)) {
    return null;
  }
  const customerId = textOrNull(payload["id"]);
  if (customerId === null) {
    return null;
  }
  const entity: AssistantCustomerEntityData = {
    kind: "customer-entity",
    destination: resolveAssistantSurfaceDestination(
      CUSTOMER_ENTITY_DESTINATION,
      `/customers/clients/${customerId}/edit`,
    ),
    customerId,
    name: textOrNull(payload["name"]),
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
    if (!CUSTOMER_ENTITY_TOOLS.has(result.toolName)) {
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
