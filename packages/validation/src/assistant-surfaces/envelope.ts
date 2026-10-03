/**
 * Live-turn `data-presentation` envelope (SHO-458). Names the surface
 * the shared compose already chose. Not persisted (ADR-0011).
 */
import { z } from "zod";

import {
  assistantSurfacesFromToolResults,
  type AssistantSurfaceData,
} from "./compose.js";
import { CUSTOMERS_LIST_CUSTOMERS_TOOL } from "./customers-list.js";
import {
  lastSuccessfulResult,
  type AssistantSurfaceToolResult,
} from "./helpers.js";
import {
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
} from "./orders-list.js";
import { PRICE_LISTS_PRICE_LISTS_TOOL } from "./price-lists.js";
import { PRODUCTS_LIST_PRODUCTS_TOOL } from "./products-list.js";
import {
  ASSISTANT_SURFACE_REGISTRY,
  type AssistantSurfaceDescriptor,
} from "./registry.js";
import {
  SEARCH_QUERY_ACTION_NAME,
  SEARCH_QUERY_TOOL,
} from "./search-results.js";

export const staffAssistantPresentationEnvelopeSchema = z.object({
  surface: z.string().min(1),
  version: z.number().int().positive(),
  toolCallIds: z.array(z.string().min(1)),
});

export type StaffAssistantPresentationEnvelope = z.infer<
  typeof staffAssistantPresentationEnvelopeSchema
>;

export function isStaffAssistantPresentationEnvelope(
  value: unknown,
): value is StaffAssistantPresentationEnvelope {
  return staffAssistantPresentationEnvelopeSchema.safeParse(value).success;
}

export function staffAssistantPresentationDescriptor(
  kind: string,
  version: number,
): AssistantSurfaceDescriptor | undefined {
  for (const descriptor of ASSISTANT_SURFACE_REGISTRY) {
    if (descriptor.kind === kind && descriptor.version === version) {
      return descriptor;
    }
  }
  return undefined;
}

function pushUniqueId(ids: string[], toolCallId: string | undefined): void {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return;
  }
  if (ids.includes(toolCallId)) {
    return;
  }
  ids.push(toolCallId);
}

function toolCallIdsForSurface(
  surface: AssistantSurfaceData,
  results: readonly AssistantSurfaceToolResult[],
): string[] {
  const ids: string[] = [];
  switch (surface.kind) {
    case "order-entity":
    case "customer-entity":
    case "product-entity": {
      pushUniqueId(ids, surface.toolCallId);
      return ids;
    }
    case "orders-list": {
      const page = lastSuccessfulResult(
        results,
        (name) => name === ORDERS_LIST_PAGE_TOOL,
      );
      const counts = lastSuccessfulResult(
        results,
        (name) => name === ORDERS_LIST_COUNTS_TOOL,
      );
      pushUniqueId(ids, page?.toolCallId);
      pushUniqueId(ids, counts?.toolCallId);
      return ids;
    }
    case "customers-list": {
      const page = lastSuccessfulResult(
        results,
        (name) => name === CUSTOMERS_LIST_CUSTOMERS_TOOL,
      );
      pushUniqueId(ids, page?.toolCallId);
      return ids;
    }
    case "products-list": {
      const page = lastSuccessfulResult(
        results,
        (name) => name === PRODUCTS_LIST_PRODUCTS_TOOL,
      );
      pushUniqueId(ids, page?.toolCallId);
      return ids;
    }
    case "price-lists": {
      const page = lastSuccessfulResult(
        results,
        (name) => name === PRICE_LISTS_PRICE_LISTS_TOOL,
      );
      pushUniqueId(ids, page?.toolCallId);
      return ids;
    }
    case "search-results": {
      const search = lastSuccessfulResult(
        results,
        (name) =>
          name === SEARCH_QUERY_TOOL || name === SEARCH_QUERY_ACTION_NAME,
      );
      pushUniqueId(ids, search?.toolCallId);
      return ids;
    }
    case "orders-aggregate": {
      const counts = lastSuccessfulResult(
        results,
        (name) => name === ORDERS_LIST_COUNTS_TOOL,
      );
      pushUniqueId(ids, counts?.toolCallId);
      return ids;
    }
  }
  const unhandledSurfaceKind: never = surface;
  return unhandledSurfaceKind;
}

/**
 * One envelope per composed kind, using the same registry decision as
 * spoken text. `toolCallIds` are the contributing live-turn calls.
 */
export function staffAssistantPresentationEnvelopesFromToolResults(
  results: readonly AssistantSurfaceToolResult[],
): readonly StaffAssistantPresentationEnvelope[] {
  const surfaces = assistantSurfacesFromToolResults(results);
  const idsByKind = new Map<string, string[]>();
  for (const surface of surfaces) {
    const existing = idsByKind.get(surface.kind) ?? [];
    for (const id of toolCallIdsForSurface(surface, results)) {
      pushUniqueId(existing, id);
    }
    idsByKind.set(surface.kind, existing);
  }
  const envelopes: StaffAssistantPresentationEnvelope[] = [];
  for (const descriptor of ASSISTANT_SURFACE_REGISTRY) {
    const ids = idsByKind.get(descriptor.kind);
    if (ids === undefined) {
      continue;
    }
    envelopes.push({
      surface: descriptor.kind,
      version: descriptor.version,
      toolCallIds: ids,
    });
  }
  return envelopes;
}
