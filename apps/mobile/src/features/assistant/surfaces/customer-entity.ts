import {
  ASSISTANT_ENTITY_ARCHIVED_STATUS,
  CUSTOMER_ENTITY_DESTINATION,
  CUSTOMER_ENTITY_PROMPT_LINE,
  CUSTOMER_ENTITY_SURFACE_TOOLS,
  type AssistantCustomerEntityData,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import {
  entityCardId,
  entityCardRecord,
  type AssistantEntityCardView,
} from "./entity-card-view";

export { CUSTOMER_ENTITY_PROMPT_LINE, CUSTOMER_ENTITY_SURFACE_TOOLS };

function contactRows(data: AssistantCustomerEntityData): readonly string[] {
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
): AssistantEntityCardView {
  const archived = data.status === ASSISTANT_ENTITY_ARCHIVED_STATUS;
  const record = entityCardRecord(
    "customer",
    CUSTOMER_ENTITY_DESTINATION,
    data.customerId,
  );
  return {
    kind: "customer-entity",
    destination: record.destination,
    handoffLabel: assistantCopy(locale).cards.openCustomer,
    id: entityCardId(data.toolCallId, `customer-entity:${data.customerId}`),
    recordId: data.customerId,
    href: record.href,
    title: data.name ?? data.customerId,
    detailRows: contactRows(data),
    valueLabel: null,
    statusLabel: archived ? customersCopy(locale).archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
    footnotes: [],
  };
}
