/**
 * Search-results surface (SHO-535). Localizes shared
 * `@showzy/validation/assistant-surfaces` search-results data. Grouped
 * hits with per-row hrefs from typed ids. Do not import `@showzy/ai`.
 * Do not parse `sublabel` for a route. Variant open uses `productId`.
 */
import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX,
  isRecord,
  type AssistantSearchEntityType,
  type AssistantSearchGroupData,
  type AssistantSearchHitData,
  type AssistantSearchResultsData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import type { Locale } from "../../../i18n/locale";
import { productPhotoHref } from "../../catalog/products/shared/product-hrefs";
import {
  counterpartyEditorHref,
  customerEditorHref,
  groupEditorHref,
} from "../../customers/shared/customer-hrefs";
import { documentsHref } from "../../documents/shared/document-hrefs";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import type { AssistantResultMarks } from "./marks";

export type AssistantSearchResultsHitView = {
  readonly id: string;
  readonly href: string | null;
  readonly title: string;
  readonly meta: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
};

export type AssistantSearchResultsGroupView = {
  readonly entityType: AssistantSearchEntityType;
  readonly heading: string;
  readonly truncated: boolean;
  readonly truncatedLabel: string | null;
  readonly emptyLabel: string | null;
  readonly collection: AssistantCollectionView;
  readonly hits: readonly AssistantSearchResultsHitView[];
};

export type AssistantSearchResultsCardView = {
  readonly kind: "search-results";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly queryNormalized: string;
  readonly groups: readonly AssistantSearchResultsGroupView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: string | null;
  readonly marks?: AssistantResultMarks;
};

function searchHitHref(
  type: AssistantSearchEntityType,
  hit: AssistantSearchHitData,
): string | null {
  switch (type) {
    case "order":
      return orderDetailHref(hit.id);
    case "customer":
      return customerEditorHref(hit.id);
    case "customerGroup":
      return groupEditorHref(hit.id);
    case "counterparty":
      return counterpartyEditorHref(hit.id);
    case "product":
      return productPhotoHref(hit.id);
    case "variant":
      return hit.productId === null ? null : productPhotoHref(hit.productId);
    case "priceList":
      return priceListEditorHref(hit.id);
    case "document":
      return documentsHref();
  }
}

function localizeHit(
  type: AssistantSearchEntityType,
  hit: AssistantSearchHitData,
  archivedLabel: string,
): AssistantSearchResultsHitView {
  const archived = hit.status === "archived";
  return {
    id: hit.id,
    href: searchHitHref(type, hit),
    title: hit.label,
    meta: hit.sublabel,
    statusLabel: archived ? archivedLabel : null,
    statusTone: archived ? "attention" : "neutral",
  };
}

function collectionRowsFromHits(
  hits: readonly AssistantSearchResultsHitView[],
): AssistantCollectionView["rows"] {
  return hits.map((hit) => ({
    id: hit.id,
    title: hit.title,
    badge: hit.statusLabel,
    badgeTone: hit.statusTone,
    meta: hit.meta,
    cells: [],
    href: hit.href,
  }));
}

function localizeGroup(
  group: AssistantSearchGroupData,
  locale: Locale,
): AssistantSearchResultsGroupView {
  const chrome = sharedAssistantCopy(locale).searchResults;
  const hits = group.hits.map((hit) =>
    localizeHit(group.entityType, hit, chrome.archived),
  );
  return {
    entityType: group.entityType,
    heading: chrome.groups[group.entityType],
    truncated: group.truncated,
    truncatedLabel: group.truncated ? chrome.truncated : null,
    emptyLabel: hits.length === 0 ? chrome.groupEmpty : null,
    collection: localizeAssistantCollection(
      {
        columns: [
          {
            id: "title",
            label: "",
            width: "flex",
            alignment: "start",
          },
        ],
        surface: "plain",
        rowCap: ASSISTANT_SEARCH_RESULTS_GROUP_HIT_MAX,
        truncated: group.truncated,
      },
      collectionRowsFromHits(hits),
    ),
    hits,
  };
}

/**
 * Live host `cards[]` already carry composed `AssistantSearchResultsData`
 * (`entityType`, not tool-output `type`). Conversation reload stays
 * unrestorable (`hydratable: false`); this only type-guards envelope data.
 */
export function isSearchResultsResumeData(
  data: unknown,
): data is AssistantSearchResultsData {
  if (!isRecord(data) || data.kind !== "search-results") {
    return false;
  }
  if (typeof data.queryNormalized !== "string") {
    return false;
  }
  if (!isRecord(data.destination) || data.destination.kind !== "terminal") {
    return false;
  }
  if (!Array.isArray(data.groups)) {
    return false;
  }
  for (const group of data.groups) {
    if (!isRecord(group) || !Array.isArray(group.hits)) {
      return false;
    }
  }
  return true;
}

export function localizeSearchResultsCard(
  data: AssistantSearchResultsData,
  locale: Locale,
): AssistantSearchResultsCardView {
  const chrome = sharedAssistantCopy(locale).searchResults;
  const groups = data.groups.map((group) => localizeGroup(group, locale));
  const hitCount = groups.reduce((sum, group) => sum + group.hits.length, 0);
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  if (data.truncated) {
    footnotes.push(chrome.truncated);
  }
  const empty = hitCount === 0 && groups.length === 0;
  return {
    kind: "search-results",
    destination: data.destination,
    handoffLabel: chrome.handoffLabel,
    queryNormalized: data.queryNormalized,
    groups,
    emptyTitle: empty ? chrome.emptyTitle : null,
    emptyDescription: empty ? chrome.emptyDescription : null,
    footnotes,
    ctaLabel: null,
    ctaHref: null,
  };
}
