/**
 * SHO-367 / SHO-385 / SHO-456 compose: page (+ optional counts) → one
 * list surface; counts-only → one aggregate; never both; N entity
 * surfaces from get/create. Do not walk `items[].orderId` into entities.
 */
import {
  assistantSurfacesFromToolResults,
  isAssistantSurfaceResultOutput,
  type AssistantSurfaceData,
} from "@showzy/validation/assistant-surfaces";

import type { Locale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import { toolNameFromPart } from "../shared/turn-timeline";
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

export type AssistantSurface =
  | AssistantOrdersListCardView
  | AssistantOrdersAggregateCardView
  | AssistantOrderEntityCardView;

export function assistantSurfaceKey(surface: AssistantSurface): string {
  switch (surface.kind) {
    case "orders-list":
      return "orders-list";
    case "orders-aggregate":
      return "orders-aggregate";
    case "order-entity":
      return surface.id;
  }
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
      return localizeOrderEntityCard(data, ordersCopy(locale));
  }
}

/**
 * Discriminated result-card surfaces for one assistant turn. Timeline and
 * HITL confirmation stay outside this list.
 */
export function assistantSurfacesFromParts(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): readonly AssistantSurface[] {
  const results = assistantSurfaceToolResultsFromParts(parts);
  return assistantSurfacesFromToolResults(results).map((data) =>
    localizeSurface(data, locale, parts),
  );
}
