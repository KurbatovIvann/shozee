import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ASSISTANT_PRICE_LISTS_ROW_MAX,
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  PRICE_LISTS_PROMPT_LINE,
  PRICE_LISTS_SURFACE_TOOLS,
  type AssistantPriceListsData,
  type AssistantPriceListsRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import type { Locale } from "../../../i18n/locale";
import { pricingCopy } from "../../../i18n/pricing";
import { entryCountLabel } from "../../pricing/shared/entry-count";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_PRICE_LISTS_HREF = ASSISTANT_PRICE_LISTS_SCREEN_HREF;

export {
  ASSISTANT_PRICE_LISTS_ROW_MAX,
  PRICE_LISTS_PROMPT_LINE,
  PRICE_LISTS_SURFACE_TOOLS,
};

export type AssistantPriceListsRowView = {
  readonly priceListId: string;
  readonly href: string;
  readonly name: string;
  readonly badgeLabel: string | null;
  readonly badgeTone: StatusPillTone;
  readonly metaLabel: string;
};

export type AssistantPriceListsCardView = {
  readonly kind: "price-lists";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantPriceListsRowView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_PRICE_LISTS_HREF | null;
  readonly marks?: AssistantResultMarks;
};

function rowBadge(
  row: AssistantPriceListsRowData,
  pricing: ReturnType<typeof pricingCopy>,
): { readonly label: string | null; readonly tone: StatusPillTone } {
  if (!row.isActive) {
    return { label: pricing.inactiveBadge, tone: "attention" };
  }
  if (row.isDefault) {
    return { label: pricing.defaultBadge, tone: "success" };
  }
  return { label: null, tone: "neutral" };
}

function localizePriceListRow(
  row: AssistantPriceListsRowData,
  locale: Locale,
  pricing: ReturnType<typeof pricingCopy>,
): AssistantPriceListsRowView {
  const badge = rowBadge(row, pricing);
  return {
    priceListId: row.priceListId,
    href: priceListEditorHref(row.priceListId),
    name: row.name,
    badgeLabel: badge.label,
    badgeTone: badge.tone,
    metaLabel:
      row.entryCount === null
        ? ""
        : entryCountLabel(row.entryCount, locale, pricing.prices),
  };
}

function collectionRowsFromLocalized(
  rows: readonly AssistantPriceListsRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.priceListId,
    title: row.name,
    badge: row.badgeLabel,
    badgeTone: row.badgeTone,
    meta: row.metaLabel.length > 0 ? row.metaLabel : null,
    cells: [],
    href: row.href,
  }));
}

export function localizePriceListsCard(
  data: AssistantPriceListsData,
  locale: Locale,
): AssistantPriceListsCardView {
  const chrome = sharedAssistantCopy(locale).priceLists;
  const pricing = pricingCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizePriceListRow(row, locale, pricing),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_PRICE_LISTS_HREF
      ? ASSISTANT_PRICE_LISTS_HREF
      : null;
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "price-lists",
    destination: data.destination,
    handoffLabel: chrome.openList,
    collection: localizeAssistantCollection(
      data.collection,
      collectionRowsFromLocalized(parsedRows),
    ),
    rows: parsedRows,
    emptyTitle: empty ? chrome.listEmptyTitle : null,
    emptyDescription: empty ? chrome.listEmptyDescription : null,
    footnotes,
    ctaLabel: ctaHref !== null ? chrome.openList : null,
    ctaHref,
  };
}
