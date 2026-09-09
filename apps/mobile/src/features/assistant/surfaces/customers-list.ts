/**
 * Customers list result surface (SHO-472). Localizes shared
 * `@showzy/validation/assistant-surfaces` customers-list data onto the
 * same collection view as orders-list. Do not walk customer ids into
 * entity cards. Do not import `@showzy/ai`.
 */
import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
  CUSTOMERS_LIST_PROMPT_LINE,
  CUSTOMERS_LIST_SURFACE_TOOLS,
  type AssistantCustomersListData,
  type AssistantCustomersListRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import { customerEditorHref } from "../../customers/shared/customer-hrefs";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_CUSTOMERS_LIST_HREF =
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF;

export {
  ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
  CUSTOMERS_LIST_PROMPT_LINE,
  CUSTOMERS_LIST_SURFACE_TOOLS,
};

export type AssistantCustomersListRowView = {
  readonly customerId: string;
  readonly href: string;
  readonly name: string;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly metaLabel: string;
};

export type AssistantCustomersListCardView = {
  readonly kind: "customers-list";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantCustomersListRowView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_CUSTOMERS_LIST_HREF | null;
  readonly marks?: AssistantResultMarks;
};

function joinMeta(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(" · ");
}

function localizeCustomerRow(
  row: AssistantCustomersListRowData,
  archivedLabel: string,
): AssistantCustomersListRowView {
  const archived = row.status === "archived";
  return {
    customerId: row.customerId,
    href: customerEditorHref(row.customerId),
    name: row.name,
    statusLabel: archived ? archivedLabel : null,
    statusTone: archived ? "attention" : "neutral",
    metaLabel: joinMeta([row.phone ?? "", row.email ?? ""]),
  };
}

function collectionRowsFromLocalized(
  rows: readonly AssistantCustomersListRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.customerId,
    title: row.name,
    badge: row.statusLabel,
    badgeTone: row.statusTone,
    meta: row.metaLabel.length > 0 ? row.metaLabel : null,
    cells: [],
    href: row.href,
  }));
}

export function localizeCustomersListCard(
  data: AssistantCustomersListData,
  locale: Locale,
): AssistantCustomersListCardView {
  const chrome = sharedAssistantCopy(locale).customersList;
  const customers = customersCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizeCustomerRow(row, customers.archivedBadge),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_CUSTOMERS_LIST_HREF
      ? ASSISTANT_CUSTOMERS_LIST_HREF
      : null;
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "customers-list",
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
