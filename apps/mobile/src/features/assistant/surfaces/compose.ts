/**
 * SHO-367 / SHO-385 / SHO-456 / SHO-458 / SHO-472 compose: page
 * (+ optional counts) → one orders-list; counts-only → one aggregate;
 * never both; customers-list from `customers_list_customers`; N entity
 * surfaces from get/create. Live turns prefer the server
 * `data-presentation` envelope; absent / unknown / malformed fall back
 * to the shared parse. Do not walk `items[].orderId` or customer ids
 * into entities.
 */
import {
  ASSISTANT_SURFACE_REGISTRY,
  assistantSurfacesFromToolResults,
  isAssistantSurfaceResultOutput,
  staffAssistantPresentationDescriptor,
  staffAssistantPresentationEnvelopeSchema,
  type AssistantSurfaceData,
  type AssistantSurfaceDescriptor,
  type AssistantSurfaceToolResult,
  type StaffAssistantPresentationEnvelope,
} from "@showzy/validation/assistant-surfaces";

import type { Locale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import { toolNameFromPart } from "../shared/turn-timeline";
import {
  localizeCustomersListCard,
  type AssistantCustomersListCardView,
} from "./customers-list";
import { assistantSurfaceToolResultsFromParts } from "./helpers";
import {
  localizeOrderEntityCard,
  type AssistantOrderEntityCardView,
} from "./order-entity";
import {
  localizeOrdersAggregateCard,
  type AssistantOrdersAggregateCardView,
} from "./orders-aggregate";
import {
  localizeOrdersListCard,
  ORDERS_LIST_COUNTS_TOOL,
  type AssistantOrdersListCardView,
} from "./orders-list";
import {
  isSearchResultsResumeData,
  localizeSearchResultsCard,
  type AssistantSearchResultsCardView,
} from "./search-results";

const PRESENTATION_PART_TYPE = "data-presentation";
const RESUME_CARD_PART_TYPE = "data-resumeCard";

export type AssistantSurface =
  | AssistantOrdersListCardView
  | AssistantOrdersAggregateCardView
  | AssistantOrderEntityCardView
  | AssistantCustomersListCardView
  | AssistantSearchResultsCardView;

export function assistantSurfaceKey(surface: AssistantSurface): string {
  switch (surface.kind) {
    case "orders-list":
      return "orders-list";
    case "orders-aggregate":
      return "orders-aggregate";
    case "order-entity":
      return surface.id;
    case "customers-list":
      return "customers-list";
    case "search-results":
      return "search-results";
  }
  const unhandledSurfaceKind: never = surface;
  return unhandledSurfaceKind;
}

function lastCountsInput(parts: readonly AssistantChatPart[]): unknown {
  let found: unknown;
  for (const part of parts) {
    const toolName = toolNameFromPart(part);
    if (toolName !== ORDERS_LIST_COUNTS_TOOL) {
      continue;
    }
    if (part.state !== "output-available") {
      continue;
    }
    if (!isAssistantSurfaceResultOutput(part.output)) {
      continue;
    }
    found = part.input;
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function surfacesFromResumeCards(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): readonly AssistantSurface[] {
  const surfaces: AssistantSurface[] = [];
  for (const part of parts) {
    if (part.type !== RESUME_CARD_PART_TYPE) {
      continue;
    }
    const data = part.data;
    if (!isRecord(data)) {
      continue;
    }
    if (isSearchResultsResumeData(data)) {
      surfaces.push(localizeSurface(data, locale, parts));
      continue;
    }
    if (data.kind !== "order-entity") {
      continue;
    }
    const orderId = data.orderId;
    const orderNumber = data.orderNumber;
    if (typeof orderId !== "string" || typeof orderNumber !== "string") {
      continue;
    }
    surfaces.push(
      localizeOrderEntityCard(
        {
          kind: "order-entity",
          destination: { kind: "screen", href: `/orders/${orderId}` },
          orderId,
          orderNumber,
          customerNameSnapshot:
            typeof data.customerNameSnapshot === "string"
              ? data.customerNameSnapshot
              : null,
          status: typeof data.status === "string" ? data.status : null,
          total: null,
        },
        ordersCopy(locale),
        locale,
      ),
    );
  }
  return surfaces;
}

function localizeSurface(
  data: AssistantSurfaceData,
  locale: Locale,
  parts: readonly AssistantChatPart[],
): AssistantSurface {
  switch (data.kind) {
    case "orders-list":
      return localizeOrdersListCard(data, locale);
    case "orders-aggregate":
      return localizeOrdersAggregateCard(data, locale, lastCountsInput(parts));
    case "order-entity":
      return localizeOrderEntityCard(data, ordersCopy(locale), locale);
    case "customers-list":
      return localizeCustomersListCard(data, locale);
    case "search-results":
      return localizeSearchResultsCard(data, locale);
  }
  const unhandledSurfaceKind: never = data;
  return unhandledSurfaceKind;
}

function composeSurfacesFromParts(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): readonly AssistantSurface[] {
  const results = assistantSurfaceToolResultsFromParts(parts);
  return assistantSurfacesFromToolResults(results).map((data) =>
    localizeSurface(data, locale, parts),
  );
}

function scopeResults(
  results: readonly AssistantSurfaceToolResult[],
  toolCallIds: readonly string[],
): readonly AssistantSurfaceToolResult[] {
  if (toolCallIds.length === 0) {
    return results;
  }
  const wanted = new Set(toolCallIds);
  return results.filter(
    (result) =>
      result.toolCallId !== undefined && wanted.has(result.toolCallId),
  );
}

function parsedFromDescriptor(
  descriptor: AssistantSurfaceDescriptor,
  results: readonly AssistantSurfaceToolResult[],
): readonly AssistantSurfaceData[] {
  const parsed = descriptor.parse(results);
  if (parsed === null) {
    return [];
  }
  if ("kind" in parsed) {
    return [parsed];
  }
  const surfaces: AssistantSurfaceData[] = [];
  for (const surface of parsed) {
    surfaces.push(surface);
  }
  return surfaces;
}

function surfacesFromNamedEnvelopes(
  envelopes: readonly StaffAssistantPresentationEnvelope[],
  parts: readonly AssistantChatPart[],
  locale: Locale,
): readonly AssistantSurface[] {
  const results = assistantSurfaceToolResultsFromParts(parts);
  const byKind = new Map<string, StaffAssistantPresentationEnvelope>();
  for (const envelope of envelopes) {
    byKind.set(envelope.surface, envelope);
  }
  const surfaces: AssistantSurface[] = [];
  for (const descriptor of ASSISTANT_SURFACE_REGISTRY) {
    const envelope = byKind.get(descriptor.kind);
    if (envelope === undefined) {
      continue;
    }
    const scoped = scopeResults(results, envelope.toolCallIds);
    for (const data of parsedFromDescriptor(descriptor, scoped)) {
      surfaces.push(localizeSurface(data, locale, parts));
    }
  }
  return surfaces;
}

/**
 * Named envelopes from the live turn. Unknown kind/version or a
 * malformed part fall back to compose so an old app never crashes or
 * paints a partial card. Envelope absent → the SHO-456 compose path.
 */
function namedPresentationEnvelopes(
  parts: readonly AssistantChatPart[],
): readonly StaffAssistantPresentationEnvelope[] | null {
  const envelopes: StaffAssistantPresentationEnvelope[] = [];
  let sawPresentation = false;
  for (const part of parts) {
    if (part.type !== PRESENTATION_PART_TYPE) {
      continue;
    }
    sawPresentation = true;
    const parsed = staffAssistantPresentationEnvelopeSchema.safeParse(
      part.data,
    );
    if (!parsed.success) {
      continue;
    }
    envelopes.push(parsed.data);
  }
  if (!sawPresentation || envelopes.length === 0) {
    return null;
  }
  for (const envelope of envelopes) {
    if (
      staffAssistantPresentationDescriptor(
        envelope.surface,
        envelope.version,
      ) === undefined
    ) {
      return null;
    }
  }
  return envelopes;
}

/**
 * Discriminated result-card surfaces for one assistant turn. Timeline and
 * HITL confirmation stay outside this list.
 */
export function assistantSurfacesFromParts(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): readonly AssistantSurface[] {
  const resume = surfacesFromResumeCards(parts, locale);
  const named = namedPresentationEnvelopes(parts);
  const composed =
    named !== null
      ? surfacesFromNamedEnvelopes(named, parts, locale)
      : composeSurfacesFromParts(parts, locale);
  if (resume.length === 0) {
    return composed;
  }
  if (composed.length === 0) {
    return resume;
  }
  return [...resume, ...composed];
}
