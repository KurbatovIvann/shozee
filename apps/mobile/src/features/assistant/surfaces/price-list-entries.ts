import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  PRICE_LIST_ENTRIES_PROMPT_LINE,
  PRICE_LIST_ENTRIES_SURFACE_TOOLS,
  type AssistantPriceListEntriesData,
  type AssistantPriceListEntriesRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import type { Locale } from "../../../i18n/locale";
import {
  priceListEditorHref,
  priceListsHref,
} from "../../pricing/shared/price-list-hrefs";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import { formatMoneyAmount } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_PRICE_LIST_ENTRIES_HREF =
  ASSISTANT_PRICE_LISTS_SCREEN_HREF;

export {
  ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
  PRICE_LIST_ENTRIES_PROMPT_LINE,
  PRICE_LIST_ENTRIES_SURFACE_TOOLS,
};

export type AssistantPriceListEntriesRowView = {
  readonly entryId: string;
  readonly href: string;
  readonly productId: string;
  readonly badgeLabel: string | null;
  readonly badgeTone: StatusPillTone;
  readonly priceLabel: string | null;
};

export type AssistantPriceListEntriesCardView = {
  readonly kind: "price-list-entries";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantPriceListEntriesRowView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_PRICE_LIST_ENTRIES_HREF | null;
  readonly marks?: AssistantResultMarks;
};

function rowHref(row: AssistantPriceListEntriesRowData): string {
  return row.priceListId === null
    ? priceListsHref()
    : priceListEditorHref(row.priceListId);
}

function localizeEntryRow(
  row: AssistantPriceListEntriesRowData,
  variantRow: string,
): AssistantPriceListEntriesRowView {
  return {
    entryId: row.entryId,
    href: rowHref(row),
    productId: row.productId ?? "",
    badgeLabel: row.variantId === null ? null : variantRow,
    badgeTone: row.variantId === null ? "neutral" : "focus",
    priceLabel: formatMoneyAmount(row.price),
  };
}

function collectionRowsFromLocalized(
  rows: readonly AssistantPriceListEntriesRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.entryId,
    title: row.productId,
    badge: row.badgeLabel,
    badgeTone: row.badgeTone,
    meta: null,
    cells: row.priceLabel !== null ? [row.priceLabel] : [],
    href: row.href,
  }));
}

export function localizePriceListEntriesCard(
  data: AssistantPriceListEntriesData,
  locale: Locale,
): AssistantPriceListEntriesCardView {
  const chrome = sharedAssistantCopy(locale).priceListEntries;
  const parsedRows = data.rows.map((row) =>
    localizeEntryRow(row, chrome.variantRow),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_PRICE_LIST_ENTRIES_HREF
      ? ASSISTANT_PRICE_LIST_ENTRIES_HREF
      : null;
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "price-list-entries",
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
