/**
 * Live-turn `data-presentation` envelope (SHO-458). Names the surface
 * the shared compose already chose. Not persisted (ADR-0011).
 */
import { z } from "zod";

import {
  assistantSurfacesFromToolResults,
  type AssistantSurfaceData,
} from "./compose.js";
import {
  lastSuccessfulResult,
  type AssistantSurfaceToolResult,
} from "./helpers.js";
import {
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
} from "./orders-list.js";
import {
  ASSISTANT_SURFACE_REGISTRY,
  type AssistantSurfaceDescriptor,
} from "./registry.js";

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
  if (surface.kind === "order-entity") {
    pushUniqueId(ids, surface.toolCallId);
    return ids;
  }
  if (surface.kind === "orders-list") {
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
  const counts = lastSuccessfulResult(
    results,
    (name) => name === ORDERS_LIST_COUNTS_TOOL,
  );
  pushUniqueId(ids, counts?.toolCallId);
  return ids;
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
