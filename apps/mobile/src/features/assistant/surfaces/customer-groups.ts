import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ASSISTANT_CUSTOMER_GROUPS_ROW_MAX,
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
  CUSTOMER_GROUPS_PROMPT_LINE,
  CUSTOMER_GROUPS_SURFACE_TOOLS,
  type AssistantCustomerGroupsData,
  type AssistantCustomerGroupsRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import { groupEditorHref } from "../../customers/shared/customer-hrefs";
import { memberCountLabel } from "../../customers/shared/member-count";
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_CUSTOMER_GROUPS_HREF =
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF;

export {
  ASSISTANT_CUSTOMER_GROUPS_ROW_MAX,
  CUSTOMER_GROUPS_PROMPT_LINE,
  CUSTOMER_GROUPS_SURFACE_TOOLS,
};

export type AssistantCustomerGroupsRowView = {
  readonly groupId: string;
  readonly href: string;
  readonly name: string;
  readonly membersLabel: string;
};

export type AssistantCustomerGroupsCardView = {
  readonly kind: "customer-groups";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantCustomerGroupsRowView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_CUSTOMER_GROUPS_HREF | null;
  readonly marks?: AssistantResultMarks;
};

function localizeGroupRow(
  row: AssistantCustomerGroupsRowData,
  locale: Locale,
  customers: ReturnType<typeof customersCopy>,
): AssistantCustomerGroupsRowView {
  return {
    groupId: row.groupId,
    href: groupEditorHref(row.groupId),
    name: row.name,
    membersLabel:
      row.memberCount === null
        ? ""
        : memberCountLabel(row.memberCount, locale, customers.members),
  };
}

function collectionRowsFromLocalized(
  rows: readonly AssistantCustomerGroupsRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.groupId,
    title: row.name,
    badge: row.membersLabel.length > 0 ? row.membersLabel : null,
    badgeTone: "neutral" as const,
    meta: null,
    cells: [],
    href: row.href,
  }));
}

export function localizeCustomerGroupsCard(
  data: AssistantCustomerGroupsData,
  locale: Locale,
): AssistantCustomerGroupsCardView {
  const chrome = sharedAssistantCopy(locale).customerGroups;
  const customers = customersCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizeGroupRow(row, locale, customers),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_CUSTOMER_GROUPS_HREF
      ? ASSISTANT_CUSTOMER_GROUPS_HREF
      : null;
  const footnotes: string[] = [];
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "customer-groups",
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
