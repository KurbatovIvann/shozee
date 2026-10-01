/**
 * A stored card payload → the localized view a block renders.
 *
 * This file used to hold three routes to the same `AssistantSurface[]`: from
 * resume cards the client had appended, from a named `data-presentation`
 * envelope, and from a re-derivation over raw tool parts. Which one ran depended
 * on what happened to be in the message, and when two disagreed the same order
 * appeared twice or not at all.
 *
 * The server now stores the surface it composed, so there is one route and no
 * composition left to do here — only localization, which is the client's half.
 */
import {
  ASSISTANT_SURFACE_REGISTRY,
  type AssistantSurfaceData,
} from "@showzy/validation/assistant-surfaces";

import type { Locale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import {
  localizeCustomersListCard,
  type AssistantCustomersListCardView,
} from "./customers-list";
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
  type AssistantOrdersListCardView,
} from "./orders-list";
import {
  localizeSearchResultsCard,
  type AssistantSearchResultsCardView,
} from "./search-results";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Known gap: an `orders-aggregate` loses its period label and group-by overlay.
 * Both came from the counts tool's *input*, which a stored card payload does not
 * carry. Closing it is a change to what the server writes, not to this file.
 */
function localizeSurface(
  data: AssistantSurfaceData,
  locale: Locale,
): AssistantSurface {
  switch (data.kind) {
    case "orders-list":
      return localizeOrdersListCard(data, locale);
    case "orders-aggregate":
      return localizeOrdersAggregateCard(data, locale, undefined);
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

export function localizeAssistantCardPayload(
  type: string,
  payload: unknown,
  locale: Locale,
): AssistantSurface | null {
  if (!isRecord(payload) || payload["kind"] !== type) {
    return null;
  }
  const known = ASSISTANT_SURFACE_REGISTRY.some(
    (descriptor) => descriptor.kind === type,
  );
  if (!known) {
    return null;
  }
  try {
    return localizeSurface(payload as AssistantSurfaceData, locale);
  } catch {
    return null;
  }
}
