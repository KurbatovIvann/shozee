import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ASSISTANT_ENTITY_ARCHIVED_STATUS,
  ASSISTANT_PRODUCTS_LIST_ROW_MAX,
  ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
  PRODUCTS_LIST_PROMPT_LINE,
  PRODUCTS_LIST_SURFACE_TOOLS,
  type AssistantProductsListData,
  type AssistantProductsListRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import type { Locale } from "../../../i18n/locale";
import { productsCopy } from "../../../i18n/products";
import { productEditorHref } from "../../catalog/products/shared/product-hrefs";
import { variantCountLabel } from "../../catalog/products/shared/variant-count";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import { formatMoneyAmount } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_PRODUCTS_LIST_HREF = ASSISTANT_PRODUCTS_LIST_SCREEN_HREF;

export {
  ASSISTANT_PRODUCTS_LIST_ROW_MAX,
  PRODUCTS_LIST_PROMPT_LINE,
  PRODUCTS_LIST_SURFACE_TOOLS,
};

export type AssistantProductsListRowView = {
  readonly productId: string;
  readonly href: string;
  readonly name: string;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly metaLabel: string;
  readonly basePriceLabel: string | null;
};

export type AssistantProductsListCardView = {
  readonly kind: "products-list";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantProductsListRowView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_PRODUCTS_LIST_HREF | null;
  readonly marks?: AssistantResultMarks;
};

function localizeProductRow(
  row: AssistantProductsListRowData,
  locale: Locale,
  products: ReturnType<typeof productsCopy>,
): AssistantProductsListRowView {
  const archived = row.status === ASSISTANT_ENTITY_ARCHIVED_STATUS;
  return {
    productId: row.productId,
    href: productEditorHref(row.productId),
    name: row.name,
    statusLabel: archived ? products.archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
    metaLabel:
      row.variantCount === null
        ? ""
        : variantCountLabel(row.variantCount, locale, products.variants),
    basePriceLabel: formatMoneyAmount(row.basePrice),
  };
}

function collectionRowsFromLocalized(
  rows: readonly AssistantProductsListRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.productId,
    title: row.name,
    badge: row.statusLabel,
    badgeTone: row.statusTone,
    meta: row.metaLabel.length > 0 ? row.metaLabel : null,
    cells: row.basePriceLabel !== null ? [row.basePriceLabel] : [],
    href: row.href,
  }));
}

export function localizeProductsListCard(
  data: AssistantProductsListData,
  locale: Locale,
): AssistantProductsListCardView {
  const chrome = sharedAssistantCopy(locale).productsList;
  const products = productsCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizeProductRow(row, locale, products),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_PRODUCTS_LIST_HREF
      ? ASSISTANT_PRODUCTS_LIST_HREF
      : null;
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "products-list",
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
