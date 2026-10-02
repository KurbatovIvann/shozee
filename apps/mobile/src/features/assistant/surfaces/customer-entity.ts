import {
  ASSISTANT_ENTITY_ARCHIVED_STATUS,
  CUSTOMER_ENTITY_PROMPT_LINE,
  CUSTOMER_ENTITY_SURFACE_TOOLS,
  type AssistantCustomerEntityData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import { assistantRecordHref } from "../shared/assistant-record-hrefs";
import type { AssistantResultMarks } from "./marks";

export { CUSTOMER_ENTITY_PROMPT_LINE, CUSTOMER_ENTITY_SURFACE_TOOLS };

export type AssistantCustomerEntityCardView = {
  readonly kind: "customer-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string | null;
  readonly id: string;
  readonly customerId: string;
  readonly href: string;
  readonly name: string | null;
  readonly goneLabel: string;
  readonly detailRows: readonly string[];
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly marks?: AssistantResultMarks;
};

function detailRows(data: AssistantCustomerEntityData): readonly string[] {
  const rows: string[] = [];
  if (data.phone !== null) {
    rows.push(data.phone);
  }
  if (data.email !== null) {
    rows.push(data.email);
  }
  return rows;
}

export function localizeCustomerEntityCard(
  data: AssistantCustomerEntityData,
  locale: Locale,
): AssistantCustomerEntityCardView {
  const cards = assistantCopy(locale).cards;
  const archived = data.status === ASSISTANT_ENTITY_ARCHIVED_STATUS;
  const callId = data.toolCallId;
  return {
    kind: "customer-entity",
    destination: data.destination,
    handoffLabel: data.name === null ? null : cards.openCustomer,
    id:
      callId !== undefined && callId.length > 0
        ? callId
        : `customer-entity:${data.customerId}`,
    customerId: data.customerId,
    href: assistantRecordHref("customer", data.customerId),
    name: data.name,
    goneLabel: cards.recordGone,
    detailRows: data.name === null ? [] : detailRows(data),
    statusLabel: archived ? customersCopy(locale).archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
  };
}
